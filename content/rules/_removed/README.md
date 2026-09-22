# _removed — 已按需移出的内容

移出日期：**2026-09-16**。原因：作者明确表示不需要「风格规则 - 古言」，从本库移除。

## 内容

| 文件/目录 | 说明 |
|---|---|
| `plugins/0b8bfb3d-32e8-4395-9cb7-25d3f736b4b8/` | 「风格规则 - 古言」插件完整包（v1.0.0，含 `rules/style-historical.md`） |
| `style-historical.md` | 从 `rules/active-plugin-rules/` 移出的平铺副本（原为启用态） |

刻意保留在这（而非直接删除），以便反悔时恢复。

## 恢复方法

```bash
cp -r _removed/plugins/0b8bfb3d-32e8-4395-9cb7-25d3f736b4b8  plugins/
cp    _removed/style-historical.md  rules/active-plugin-rules/
# 编辑器侧恢复：把插件包拷回 ~/.soloent-cn/plugins/ 后在 Rules 面板重新勾选
```

## 彻底删除

确认不再需要后，整个 `_removed/` 目录可以直接删。

## 注意：编辑器侧仍是启用状态

本次只处理了本备份库。编辑器（灵蟹创作）里该规则仍在 `~/.soloent-cn/plugins/` 且处于开启状态，
需在编辑器内关闭或卸载（方式见 `../README.md` 第二节）。
