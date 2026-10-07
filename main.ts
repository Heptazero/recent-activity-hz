import {
  addIcon,
  App,
  ItemView,
  Keymap,
  Menu,
  Notice,
  PaneType,
  Plugin,
  PluginSettingTab,
  setIcon,
  setTooltip,
  Setting,
  TAbstractFile,
  TFile,
  WorkspaceLeaf,
} from 'obsidian';

import { getApiSafe } from 'front-matter-plugin-api-provider';

import { ActivityFile, ActivityKind, backfillTimes, dateGroupFor, FILE_TYPES, FileType, fileTypeFor, latestActivity } from './activity';

interface BookmarkedFile {
  ctime: number;
  path: string;
  type: string;
}

// Augmentations for internal Obsidian APIs that are not part of the documented plugin API.
// These should be used extremely sparingly.
declare module 'obsidian' {
  interface App {
    // Used to hook into Obsidian's native drag-and-drop so dragging a list
    // entry into the editor inserts a wikilink.
    dragManager: {
      dragFile(event: DragEvent, file: TFile | null): unknown;
      onDragStart(event: DragEvent, dragData: unknown): void;
    };
    // Used to read the Bookmarks core plugin's entries for the
    // "Omit bookmarked files" setting. The public API exposes no way to read
    // another core plugin's data.
    internalPlugins: {
      getEnabledPluginById(id: string): { items: BookmarkedFile[] } | null;
    };
  }
}

interface RecentFilesData {
  recentFiles: ActivityFile[];
  omittedPaths: string[];
  omittedTags: string[];
  omitBookmarks: boolean;
  trackOpened: boolean;
  trackCreated: boolean;
  trackModified: boolean;
  enabledTypes: FileType[];
  clearedAt: number;
  dismissedFiles: Record<string, number>;
  maxLength?: number;
}

const defaultMaxLength: number = 50;
const storedHistoryLength = 500;
const backfillDays = 30;
const fileTypeLabels: Record<FileType, string> = {
  markdown: '笔记', pdf: 'PDF', canvas: '画布', image: '图片',
  audio: '音频', video: '视频', other: '其他',
};
const activityLabels: Record<ActivityKind, string> = {
  opened: '打开', created: '新建', modified: '修改',
};
const groupLabels = {
  today: '今天', yesterday: '昨天', week: '近 7 天', month: '近一个月', older: '更早',
};

const DEFAULT_DATA: RecentFilesData = {
  recentFiles: [],
  omittedPaths: [],
  omittedTags: [],
  omitBookmarks: false,
  trackOpened: true,
  trackCreated: true,
  trackModified: true,
  enabledTypes: [...FILE_TYPES],
  clearedAt: 0,
  dismissedFiles: {},
};

const RecentFilesListViewType = 'recent-activity-hz-view';

class RecentFilesListView extends ItemView {
  private readonly plugin: RecentFilesPlugin;
  private selectedType: FileType | 'all' = 'all';

  // Always read through the plugin so the view stays in sync when loadData()
  // replaces the data object (e.g. via onExternalSettingsChange). Capturing the
  // reference in the constructor left the view rendering a stale, orphaned copy.
  private get data(): RecentFilesData {
    return this.plugin.data;
  }

  constructor(leaf: WorkspaceLeaf, plugin: RecentFilesPlugin) {
    super(leaf);

    this.plugin = plugin;
  }

  public async onOpen(): Promise<void> {
    this.redraw();
  }

  public getViewType(): string {
    return RecentFilesListViewType;
  }

  public getDisplayText(): string {
    return '最近活动';
  }

  public getIcon(): string {
    return 'clock';
  }

  public onPaneMenu(menu: Menu): void {
    menu
      .addItem((item) => {
        item
          .setTitle('清空列表')
          .setIcon('sweep')
          .onClick(async () => {
            this.data.recentFiles = [];
            this.data.clearedAt = Date.now();
            this.data.dismissedFiles = {};
            await this.plugin.saveData();
            this.redraw();
          });
      })
      .addItem((item) => {
        item
          .setTitle('关闭')
          .setIcon('cross')
          .onClick(() => {
            this.app.workspace.detachLeavesOfType(RecentFilesListViewType);
          });
      });
  }

  public readonly redraw = (): void => {
    const openFile = this.app.workspace.getActiveFile();

    const rootEl = createDiv({ cls: 'nav-folder mod-root' });
    const toolbar = rootEl.createDiv({ cls: 'recent-activity-toolbar' });
    const typeSelect = toolbar.createEl('select', { cls: 'dropdown recent-activity-type-filter' });
    typeSelect.createEl('option', { text: '全部类型', value: 'all' });
    for (const type of FILE_TYPES) {
      if (this.data.enabledTypes.includes(type)) {
        typeSelect.createEl('option', { text: fileTypeLabels[type], value: type });
      }
    }
    if (this.selectedType !== 'all' && !this.data.enabledTypes.includes(this.selectedType)) {
      this.selectedType = 'all';
    }
    typeSelect.value = this.selectedType;
    typeSelect.addEventListener('change', () => {
      this.selectedType = typeSelect.value as FileType | 'all';
      this.redraw();
    });
    const childrenEl = rootEl.createDiv({ cls: 'nav-folder-children' });

    // Add support for the Front Matter Title plugin (https://github.com/snezhig/obsidian-front-matter-title)
    // Get the plugin's safe API and check if the plugin is enabled.
    // If the plugin is not installed, this will not create an error.
    const frontMatterApi = getApiSafe(this.app);
    // We query the "explorer" feature because it is the closest in form to this plugin's features.
    const frontMatterEnabled =
      frontMatterApi &&
      frontMatterApi.getEnabledFeatures().contains('explorer');
    const frontMatterResolver = frontMatterEnabled
      ? frontMatterApi.getResolverFactory()?.createResolver('explorer')
      : null;

    const visibleFiles = this.data.recentFiles
      .filter((file) => this.app.vault.getFileByPath(file.path))
      .filter((file) => this.data.enabledTypes.includes(fileTypeFor(file.path)))
      .filter((file) => this.selectedType === 'all' || fileTypeFor(file.path) === this.selectedType)
      .slice(0, this.data.maxLength || defaultMaxLength);
    if (visibleFiles.length === 0) {
      childrenEl.createDiv({ cls: 'recent-activity-empty', text: '暂无符合条件的文件' });
    }
    let lastGroup = '';
    visibleFiles.forEach((currentFile) => {
      const activity = latestActivity(currentFile);
      const group = dateGroupFor(activity.at);
      if (group !== lastGroup) {
        childrenEl.createDiv({ cls: 'recent-activity-group', text: groupLabels[group] });
        lastGroup = group;
      }
      const navFile = childrenEl.createDiv({
        cls: 'tree-item nav-file recent-files-file',
      });
      const navFileTitle = navFile.createDiv({
        cls: 'tree-item-self is-clickable nav-file-title recent-files-title',
      });
      const navFileTitleContent = navFileTitle.createDiv({
        cls: 'tree-item-inner nav-file-title-content',
      });
      const navFileTag = navFileTitle.createDiv({
        cls: 'nav-file-tag',
      });
      navFileTitle.createDiv({
        cls: 'tree-item-spacer',
      });

      // If the Front Matter Title plugin is enabled, get the file's title from the plugin.
      const title = frontMatterResolver
        ? (frontMatterResolver.resolve(currentFile.path) ??
          currentFile.basename)
        : currentFile.basename;

      navFileTitleContent.setText(title);

      const detail = navFileTitle.createDiv({ cls: 'recent-activity-detail' });
      if (activity.kind) {
        const when = new Date(activity.at);
        const timeText = group === 'today' || group === 'yesterday'
          ? when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
          : when.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' });
        detail.setText(`${activityLabels[activity.kind]} · ${timeText}`);
      } else {
        detail.setText('时间未知');
      }

      const tFile = this.app.vault.getFileByPath(currentFile.path);
      const extension = tFile?.extension;
      if (extension && extension !== 'md') {
        navFileTag.setText(extension);
      }

      setTooltip(navFile, currentFile.path);

      if (openFile && currentFile.path === openFile.path) {
        navFileTitle.addClass('is-active');
      }

      navFileTitle.setAttr('draggable', 'true');
      navFileTitle.addEventListener('dragstart', (event: DragEvent) => {
        if (!currentFile?.path) return;

        const file = this.app.metadataCache.getFirstLinkpathDest(
          currentFile.path,
          '',
        );

        const { dragManager } = this.app;
        const dragData = dragManager.dragFile(event, file);
        dragManager.onDragStart(event, dragData);
      });

      navFileTitle.addEventListener('mouseover', (event: MouseEvent) => {
        if (!currentFile?.path) return;

        this.app.workspace.trigger('hover-link', {
          event,
          source: RecentFilesListViewType,
          hoverParent: rootEl,
          targetEl: navFile,
          linktext: currentFile.path,
        });
      });

      navFileTitle.addEventListener('contextmenu', (event: MouseEvent) => {
        if (!currentFile?.path) return;

        const menu = new Menu();
        menu.addItem((item) =>
          item
            .setSection('action')
        .setTitle('在新标签页打开')
            .setIcon('file-plus')
            .onClick(() => {
              this.focusFile(currentFile, 'tab');
            }),
        );
        const file = this.app.vault.getAbstractFileByPath(currentFile?.path);
        this.app.workspace.trigger(
          'file-menu',
          menu,
          file,
          'link-context-menu',
        );
        menu.showAtPosition({ x: event.clientX, y: event.clientY });
      });

      navFileTitle.addEventListener('click', (event: MouseEvent) => {
        if (!currentFile) return;

        const newLeaf = Keymap.isModEvent(event);
        this.focusFile(currentFile, newLeaf);
      });

      navFileTitle.addEventListener('mousedown', (event: MouseEvent) => {
        if (!currentFile) return;

        if (event.button === 1) {
          event.preventDefault();
          this.focusFile(currentFile, 'tab');
        }
      });

      const navFileDelete = navFileTitle.createDiv({
        cls: 'recent-files-file-delete menu-item-icon',
      });
      setIcon(navFileDelete, 'lucide-x');
      navFileDelete.addEventListener('click', (event) => {
        event.stopPropagation();
        void (async (): Promise<void> => {
          await this.removeFile(currentFile);
          this.redraw();
        })();
      });
    });

    this.contentEl.setChildrenInPlace([rootEl]);
  };

  private readonly removeFile = async (file: ActivityFile): Promise<void> => {
    this.data.dismissedFiles[file.path] = Math.max(Date.now(), latestActivity(file).at);
    this.data.recentFiles = this.data.recentFiles.filter(
      (currFile) => currFile.path !== file.path,
    );
    await this.plugin.saveData();
  };

  /**
   * Open the provided file in the most recent leaf.
   *
   * @param shouldSplit Whether the file should be opened in a new split, or in
   * the most recent split. If the most recent split is pinned, this is set to
   * true.
   */
  private readonly focusFile = (
    file: ActivityFile,
    newLeaf: boolean | PaneType,
  ): void => {
    const targetFile = this.app.vault.getFileByPath(file.path);

    if (targetFile) {
      const leaf = this.app.workspace.getLeaf(newLeaf);
      void leaf.openFile(targetFile);
    } else {
      new Notice('找不到这个文件');
      this.data.recentFiles = this.data.recentFiles.filter(
        (fp) => fp.path !== file.path,
      );
      void this.plugin.saveData();
      this.redraw();
    }
  };
}

export default class RecentFilesPlugin extends Plugin {
  public data: RecentFilesData;
  private saveQueue: Promise<void> = Promise.resolve();

  public readonly redrawView = (): void => {
    const leaf = this.app.workspace
      .getLeavesOfType(RecentFilesListViewType)
      .first();
    if (leaf?.view instanceof RecentFilesListView) {
      leaf.view.redraw();
    }
  };

  public async onload(): Promise<void> {
    console.debug('Recent Activity HZ: Loading plugin v' + this.manifest.version);

    await this.loadData();

    addIcon('sweep', sweepIcon);

    this.registerView(
      RecentFilesListViewType,
      (leaf) => new RecentFilesListView(leaf, this),
    );

    this.addCommand({
      id: 'recent-files-open',
      name: '打开最近活动',
      callback: async () => {
        let leaf: WorkspaceLeaf | null;
        [leaf] = this.app.workspace.getLeavesOfType(RecentFilesListViewType);
        if (!leaf) {
          leaf = this.app.workspace.getLeftLeaf(false);
          await leaf?.setViewState({ type: RecentFilesListViewType });
        }

        if (leaf) {
          await this.app.workspace.revealLeaf(leaf);
        }
      },
    });

    this.registerHoverLinkSource(RecentFilesListViewType, {
      display: '最近活动',
      defaultMod: true,
    });

    this.registerEvent(this.app.vault.on('rename', this.handleRename));
    this.registerEvent(this.app.vault.on('delete', this.handleDelete));
    this.registerEvent(this.app.vault.on('modify', this.handleModify));
    this.registerEvent(this.app.workspace.on('file-open', this.onFileOpen));

    // Vault 'create' also fires for existing files during initial load.
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on('create', this.handleCreate));
      void this.rescan();
    });

    this.addSettingTab(new RecentFilesSettingTab(this.app, this));
  }

  public async loadData(): Promise<void> {
    const saved = (await super.loadData()) as Partial<RecentFilesData> | null;
    this.data = { ...DEFAULT_DATA, ...saved };
    this.data.enabledTypes = (saved?.enabledTypes ?? FILE_TYPES)
      .filter((type): type is FileType => FILE_TYPES.includes(type));
    this.data.dismissedFiles = saved?.dismissedFiles ?? {};
    this.data.recentFiles = saved?.recentFiles ?? [];
    this.sortAndTrim();
  }

  public async saveData(): Promise<void> {
    this.saveQueue = this.saveQueue.catch((error: unknown) => {
      console.error('Recent Activity HZ: Failed to save settings', error);
    }).then(() => super.saveData(this.data));
    await this.saveQueue;
  }

  public async onExternalSettingsChange(): Promise<void> {
    await this.loadData();
    await this.pruneLength();
    await this.pruneOmittedFiles();
    this.redrawView();
  }

  public readonly pruneOmittedFiles = async (): Promise<void> => {
    const lengthBefore = this.data.recentFiles.length;
    this.data.recentFiles = this.data.recentFiles.filter(this.shouldAddFile);
    if (lengthBefore !== this.data.recentFiles.length) {
      await this.saveData();
    }
  };

  public readonly pruneLength = async (): Promise<void> => {
    if (this.sortAndTrim()) {
      await this.saveData();
    }
  };

  public readonly shouldAddFile = (file: ActivityFile): boolean => {
    // Matches for ignored Paths
    const patterns: string[] = this.data.omittedPaths.filter(
      (path) => path.length > 0,
    );
    const fileMatchesRegex = (pattern: string): boolean => {
      try {
        return new RegExp(pattern).test(file.path);
      } catch {
        console.error('Recent Activity HZ: Invalid regex pattern: ' + pattern);
        return false;
      }
    };

    if (patterns.some(fileMatchesRegex)) {
      return false;
    }

    // Matches for ignored Tags
    const tfile = this.app.vault.getFileByPath(file.path);
    if (tfile) {
      const omittedTags: string[] = this.data.omittedTags.filter(
        (tag) => tag.length > 0,
      );

      /*
       Tag(s) may be rendered in one of two ways. If only one tag is
       present, as a string:
       ```yaml
       tags: tag1
       ```

       or, if one or more tags are present, in an array:
       ```yaml
       tags:
        - tag1
        - journal/tag2
       ```

       If there are no tags, the `frontmatter.tags` array is empty.
      */
      const fileTags = (this.app.metadataCache.getFileCache(tfile)?.frontmatter
        ?.tags ?? '') as string | string[];

      /*
        Calling toString() here will flatten an array, or return the string.
        i.e., ["tag1", "journal/tag2"] will become "tag1,journal/tag2"

        Thus, permitting a normal regex match.

        Though undocumented, passing an array into RegExp.test() works as it is
        coerced it into a string as described.
      */
      const tagMatchesRegex = (pattern: string): boolean => {
        try {
          return new RegExp(pattern).test(fileTags.toString());
        } catch {
          console.error('Recent Activity HZ: Invalid regex pattern: ' + pattern);
          return false;
        }
      };

      if (omittedTags.some(tagMatchesRegex)) {
        return false;
      }
    }

    // Matches for Bookmarks
    const bookmarksPlugin =
      this.app.internalPlugins.getEnabledPluginById('bookmarks');
    if (tfile && this.data.omitBookmarks && bookmarksPlugin) {
      const bookmarkedFiles = bookmarksPlugin.items;
      if (bookmarkedFiles.some(({ path }) => path === tfile.path)) {
        return false;
      }
    }

    return true;
  };

  public onUserEnable(): void {
    // Open our view automatically only when the plugin is first enabled.
    void this.app.workspace.ensureSideLeaf(RecentFilesListViewType, 'left', {
      reveal: true,
    });
  }

  public readonly rescan = (): Promise<void> => this.refreshFromVault();

  private sortAndTrim(): boolean {
    this.data.recentFiles.sort((a, b) =>
      latestActivity(b).at - latestActivity(a).at || a.path.localeCompare(b.path));
    const keep = Math.max(storedHistoryLength, this.data.maxLength || defaultMaxLength);
    if (this.data.recentFiles.length > keep) {
      this.data.recentFiles.length = keep;
      return true;
    }
    return false;
  }

  private readonly onFileOpen = (file: TFile | null): void => {
    if (file && this.data.trackOpened) void this.recordActivity(file, 'opened');
    else this.redrawView();
  };

  private readonly handleCreate = (file: TAbstractFile): void => {
    if (file instanceof TFile && this.data.trackCreated) {
      void this.recordActivity(file, 'created');
    }
  };

  private readonly handleModify = (file: TAbstractFile): void => {
    if (file instanceof TFile && this.data.trackModified) {
      void this.recordActivity(file, 'modified');
    }
  };

  private readonly recordActivity = async (file: TFile, kind: ActivityKind): Promise<void> => {
    if (!this.shouldAddFile(file)) return;
    const entry = this.data.recentFiles.find((item) => item.path === file.path) ?? {
      path: file.path,
      basename: file.basename,
    };
    if (!this.data.recentFiles.includes(entry)) this.data.recentFiles.push(entry);
    entry.basename = file.basename;
    const at = Math.max(Date.now(), latestActivity(entry).at + 1);
    if (kind === 'opened') entry.openedAt = at;
    if (kind === 'created') entry.createdAt = at;
    if (kind === 'modified') entry.modifiedAt = at;
    delete this.data.dismissedFiles[file.path];
    this.sortAndTrim();
    this.redrawView();
    await this.saveData();
  };

  private readonly refreshFromVault = async (): Promise<void> => {
    const now = Date.now();
    const threshold = Math.max(this.data.clearedAt, now - backfillDays * 86_400_000);
    const byPath = new Map(this.data.recentFiles.map((file) => [file.path, file]));
    let changed = false;
    for (const file of this.app.vault.getFiles()) {
      if (!this.shouldAddFile(file)) continue;
      const dismissedAt = this.data.dismissedFiles[file.path] ?? 0;
      const { createdAt, modifiedAt } = backfillTimes(file.stat, {
        now, threshold, dismissedAt,
        trackCreated: this.data.trackCreated,
        trackModified: this.data.trackModified,
      });
      if (!createdAt && !modifiedAt) continue;
      const entry = byPath.get(file.path) ?? { path: file.path, basename: file.basename };
      if (!byPath.has(file.path)) {
        this.data.recentFiles.push(entry);
        byPath.set(file.path, entry);
        changed = true;
      }
      if (createdAt > (entry.createdAt ?? 0)) { entry.createdAt = createdAt; changed = true; }
      if (modifiedAt > (entry.modifiedAt ?? 0)) { entry.modifiedAt = modifiedAt; changed = true; }
    }
    if (changed) {
      this.sortAndTrim();
      this.redrawView();
      await this.saveData();
    }
  };

  private readonly handleRename = async (
    file: TAbstractFile,
    oldPath: string,
  ): Promise<void> => {
    const entry = this.data.recentFiles.find(
      (recentFile) => recentFile.path === oldPath,
    );
    const dismissedAt = this.data.dismissedFiles[oldPath];
    if (dismissedAt) {
      this.data.dismissedFiles[file.path] = dismissedAt;
      delete this.data.dismissedFiles[oldPath];
    }
    if (entry) {
      entry.path = file.path;
      entry.basename = this.trimExtension(file.name);
      this.redrawView();
    }
    if (entry || dismissedAt) await this.saveData();
  };

  private readonly handleDelete = async (
    file: TAbstractFile,
  ): Promise<void> => {
    const dismissedAt = this.data.dismissedFiles[file.path];
    delete this.data.dismissedFiles[file.path];
    const beforeLen = this.data.recentFiles.length;
    this.data.recentFiles = this.data.recentFiles.filter(
      (recentFile) => recentFile.path !== file.path,
    );

    if (beforeLen !== this.data.recentFiles.length) {
      this.redrawView();
    }
    if (beforeLen !== this.data.recentFiles.length || dismissedAt) {
      await this.saveData();
    }
  };

  // trimExtension can be used to turn a filename into a basename when
  // interacting with a TAbstractFile that does not have a basename property.
  // private readonly trimExtension = (name: string): string => name.split('.')[0];
  // from: https://stackoverflow.com/a/4250408/617864
  private readonly trimExtension = (name: string): string =>
    name.replace(/\.[^/.]+$/, '');
}

class RecentFilesSettingTab extends PluginSettingTab {
  private readonly plugin: RecentFilesPlugin;

  constructor(app: App, plugin: RecentFilesPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  public display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const patternFragment = activeDocument.createDocumentFragment();
    const link = activeDocument.createElement('a');
    link.href =
      'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions#writing_a_regular_expression_pattern';
    link.text = 'MDN - Regular expressions';
    patternFragment.append(
      'RegExp patterns to ignore. One pattern per line. See ',
    );
    patternFragment.append(link);
    patternFragment.append(' for help.');

    new Setting(containerEl)
      .setName('排除路径的匹配规则')
      .setDesc(patternFragment)
      .addTextArea((textArea) => {
        textArea.inputEl.setAttr('rows', 6);
        textArea
          .setPlaceholder('^daily/\n\\.png$\nfoobar.*baz')
          .setValue(this.plugin.data.omittedPaths.join('\n'));
        textArea.inputEl.onblur = (e: FocusEvent) => {
          const patterns = (e.target as HTMLInputElement).value;
          this.plugin.data.omittedPaths = patterns.split('\n');
          void this.plugin.pruneOmittedFiles();
          this.plugin.redrawView();
        };
      });

    const tagFragment = activeDocument.createDocumentFragment();
    tagFragment.append(
      'Frontmatter-tag patterns to ignore. One pattern' + ' per line.',
    );

    new Setting(containerEl)
      .setName('排除属性标签的匹配规则')
      .setDesc(tagFragment)
      .addTextArea((textArea) => {
        textArea.inputEl.setAttr('rows', 6);
        textArea
          // eslint-disable-next-line obsidianmd/ui/sentence-case -- example regex patterns, not prose
          .setPlaceholder('ignore\narchive/a/b')
          .setValue(this.plugin.data.omittedTags.join('\n'));
        textArea.inputEl.onblur = (e: FocusEvent) => {
          const patterns = (e.target as HTMLInputElement).value;
          this.plugin.data.omittedTags = patterns.split('\n');
          void this.plugin.pruneOmittedFiles();
          this.plugin.redrawView();
        };
      });

    new Setting(containerEl)
      .setName('排除已加书签的文件')
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.data.omitBookmarks).onChange((value) => {
          this.plugin.data.omitBookmarks = value;
          void this.plugin.pruneOmittedFiles();
          this.plugin.redrawView();
        });
      });

    new Setting(containerEl)
      .setName('记录打开')
      .setDesc('在 Obsidian 中打开文件时记录。')
      .addToggle((toggle) => toggle.setValue(this.plugin.data.trackOpened).onChange((value) => {
        this.plugin.data.trackOpened = value;
        void this.plugin.saveData();
      }));
    new Setting(containerEl)
      .setName('记录新建')
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- Lexis is a product name.
      .setDesc('包含 Lexis 等插件新建但未打开的笔记。')
      .addToggle((toggle) => toggle.setValue(this.plugin.data.trackCreated).onChange((value) => {
        this.plugin.data.trackCreated = value;
        void this.plugin.rescan();
        void this.plugin.saveData();
      }));
    new Setting(containerEl)
      .setName('记录修改')
      .setDesc('包含 Obsidian 或外部 AI 工具修改的文件；离线期间的修改在下次启动时补查。')
      .addToggle((toggle) => toggle.setValue(this.plugin.data.trackModified).onChange((value) => {
        this.plugin.data.trackModified = value;
        void this.plugin.rescan();
        void this.plugin.saveData();
      }));

    new Setting(containerEl).setName('文件类型').setHeading();
    for (const type of FILE_TYPES) {
      new Setting(containerEl)
        .setName(fileTypeLabels[type])
        .addToggle((toggle) => toggle
          .setValue(this.plugin.data.enabledTypes.includes(type))
          .onChange((value) => {
            this.plugin.data.enabledTypes = value
              ? [...this.plugin.data.enabledTypes, type]
              : this.plugin.data.enabledTypes.filter((item) => item !== type);
            this.plugin.redrawView();
            void this.plugin.saveData();
          }));
    }

    new Setting(containerEl)
      .setName('列表长度')
      .setDesc('筛选后最多显示多少个文件。')
      .addText((text) => {
        text.inputEl.setAttr('type', 'number');
        text.inputEl.setAttr('placeholder', defaultMaxLength);
        text
          .setValue(this.plugin.data.maxLength?.toString() || '')
          .onChange((value) => {
            const parsed = parseInt(value, 10);
            if (!Number.isNaN(parsed) && parsed <= 0) {
              new Notice('列表长度必须是正整数');
              return;
            }
          });
        text.inputEl.onblur = (e: FocusEvent) => {
          const maxfiles = (e.target as HTMLInputElement).value;
          const parsed = parseInt(maxfiles, 10);
          if (maxfiles && (!Number.isInteger(parsed) || parsed <= 0)) {
            new Notice('列表长度必须是正整数');
            text.setValue(this.plugin.data.maxLength?.toString() || '');
            return;
          }
          this.plugin.data.maxLength = maxfiles ? parsed : undefined;
          void this.plugin.pruneLength();
          this.plugin.redrawView();
          void this.plugin.saveData();
        };
      });

  }
}

const sweepIcon = `
<svg fill="currentColor" stroke="currentColor" version="1.1" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <path d="m495.72 1.582c-7.456-3.691-16.421-0.703-20.142 6.694l-136.92 274.08-26.818-13.433c-22.207-11.118-49.277-2.065-60.396 20.083l-6.713 13.405 160.96 80.616 6.713-13.411c11.087-22.143 2.227-49.18-20.083-60.381l-26.823-13.435 136.92-274.08c3.706-7.412 0.703-16.421-6.694-20.141z"/>
  <circle cx="173" cy="497" r="15"/>
  <circle cx="23" cy="407" r="15"/>
  <circle cx="83" cy="437" r="15"/>
  <path d="m113 482h-60c-8.276 0-15-6.724-15-15 0-8.291-6.709-15-15-15s-15 6.709-15 15c0 24.814 20.186 45 45 45h60c8.291 0 15-6.709 15-15s-6.709-15-15-15z"/>
  <path d="m108.64 388.07c-6.563 0.82-11.807 5.845-12.92 12.349-1.113 6.519 2.153 12.993 8.057 15.952l71.675 35.889c12.935 6.475 27.231 9.053 41.177 7.573-1.641 6.65 1.479 13.784 7.852 16.992l67.061 33.589c5.636 2.78 12.169 1.8 16.685-2.197 2.347-2.091 53.436-48.056 83.3-98.718l-161.6-80.94c-36.208 48.109-120.36 59.39-121.28 59.511z"/>
</svg>`;
