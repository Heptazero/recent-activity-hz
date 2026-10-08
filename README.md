# Recent Activity HZ

这是 [Recent Files](https://github.com/tgrosinger/recent-files-obsidian) 的独立改版。它在侧边栏合并显示最近打开、新建和修改的文件，按“今天 / 昨天 / 近 7 天 / 近一个月 / 更早”分组。顶部下拉框只列出当前活动记录中有文件的后缀；设置页列出库中可见文件的全部后缀，例如 `.MD`、`.PDF`、`.IPYNB`。以 `.` 开头的隐藏文件或目录，以及插件设置中排除的文件，不参与统计。`.canvas`、`.excalidraw`、`.excalidraw.md` 合在 `.CANVAS / .EXCALIDRAW` 一项，普通 `.md` 仍归 `.MD`。

## 为什么能看到 Lexis 和 AI 的改动

- Lexis 划词建词会创建文件，但不一定打开文件。本插件监听 Obsidian 的文件新建事件。
- AI 工具直接改写库内文件时，Obsidian 检测到的修改事件会更新列表。插件启动时还会扫描文件时间，补回过去 30 天内的离线新建和修改。
- 列表只知道文件发生了修改，无法可靠判断是 AI、人还是其他插件修改的。

每个文件只显示一条记录，以最后一次活动排序。新建后两分钟内的模板填充仍显示为“新建”。“近 7 天”指前 2–6 个自然日，“近一个月”指前 7–29 个自然日。首次启用时只能根据文件的创建、修改时间补录；过去的打开时间无法从原插件恢复。

## 安装

将构建生成的 `main.js`、`manifest.json`、`styles.css` 放到库的 `.obsidian/plugins/recent-activity-hz/`，然后在 Obsidian 的“第三方插件”中启用 **Recent Activity HZ**。它使用新的插件 ID，可以与原版并存。

## 开发

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm exec eslint .
```

本项目基于 Tony Grosinger 的 [Recent Files](https://github.com/tgrosinger/recent-files-obsidian)，保留原项目的 GPL-3.0 许可，详见 [LICENSE](LICENSE)。
