# pi-image-gen

pi 图片生成扩展。注册一个用户命令 `/image-gen`，以及原生工具：`image_gen`。

支持 GPT Image 系列（`gpt-image-2.5-flare` / `gpt-image-2.5-sunburst` / `gpt-image-2`）图片接口：

- 文生图：`POST /v1/images/generations`
- 图生图 / 编辑：`POST /v1/images/edits`（multipart，输入图字段为 `image[]`，可附带 `mask` 做局部重绘）
- 默认模型：`gpt-image-2.5-flare`
- 默认尺寸：`1024x1024`
- 默认质量：`auto`，默认背景：`auto`，默认输出格式：`png`

> 接口变化：从 GPT Image 2 起 `response_format` 已被废弃，传它会直接 400（`Unknown parameter: 'response_format'`）。接口固定返回 `data[].b64_json`，插件会自行解码保存。对应地新增 `quality`（`low`/`medium`/`high`/`xhigh`/`max`/`auto`）、`background`（`auto`/`opaque`/`transparent`）、`output_format`（`png`/`jpeg`/`webp`）、`n`（1-10）等参数。
> 旧配置里的 `responseFormat` 会被忽略；若后端不认识 `quality`/`background`/`output_format`，插件会自动去掉该参数重试，并在结果里提示被忽略的参数。

## 安装 / 加载

### GitHub 安装（推荐）

```bash
pi install git:github.com/justhil/pi-image-gen
```

或使用 HTTPS：

```bash
pi install https://github.com/justhil/pi-image-gen
```

项目本地安装：

```bash
pi install -l git:github.com/justhil/pi-image-gen
```

更新：

```bash
pi update git:github.com/justhil/pi-image-gen
```

卸载：

```bash
pi remove git:github.com/justhil/pi-image-gen
```

安装后重启 pi，或在 pi 内执行：

```text
/reload
```

### 开发测试

```bash
git clone https://github.com/justhil/pi-image-gen.git
cd pi-image-gen
npm install
npm run typecheck
pi -e ./index.ts
```

也可以直接加载本地路径：

```bash
pi -e D:/workspace/pi-ext/pi-image-gen/index.ts
```

作为 pi package 安装时，`package.json` 里已经声明：

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

## 配置

在 pi 里运行：

```text
/image-gen config
```

TUI 配置项：

- API Base URL（`http://host:port` 或 `http://host:port/v1` 都可）
- API Key
- 模型 ID：配置好 API Base URL 和 API Key 后，会自动请求 `/v1/models` 并提供模型列表选择；失败时回退手动输入
- 图片尺寸
- 图片质量：`auto` / `low` / `medium` / `high` / `xhigh` / `max`
- 背景：`auto` / `opaque` / `transparent`（transparent 需 png 或 webp）
- 输出格式：`png` / `jpeg` / `webp`
- 输出目录
- 最大并行数：控制同批 `image_gen` 工具调用最多同时请求 Image2 的数量，默认 1，范围 1-8
- 连接测试

配置文件位置：

```text
~/.pi/agent/image-gen.json
```

环境变量优先级高于配置文件：

```bash
export IMAGE2_BASE_URL="http://<api-host>:<port>" # 也兼容 http://<api-host>:<port>/v1
export IMAGE2_API_KEY="<API_KEY>"
export IMAGE2_MODEL="gpt-image-2.5-flare"
export IMAGE2_SIZE="1024x1024"
export IMAGE2_QUALITY="auto"
export IMAGE2_BACKGROUND="auto"
export IMAGE2_OUTPUT_FORMAT="png"
export IMAGE2_OUTPUT_DIR=".image-gen"
export IMAGE2_MAX_CONCURRENCY="2"
```

兼容短变量：

```bash
export BASE_URL="http://<api-host>:<port>"
export API_KEY="<API_KEY>"
export IMAGE_MODEL="gpt-image-2.5-flare"
export IMAGE_SIZE="1024x1024"
export IMAGE_QUALITY="auto"
export IMAGE_BACKGROUND="auto"
export IMAGE_OUTPUT_FORMAT="png"
export IMAGE_OUTPUT_DIR=".image-gen"
export IMAGE_MAX_CONCURRENCY="2"
```

## 原生工具

插件会注册工具：

```text
image_gen
```

注入系统提示的工具简介小于 100 字：

```text
前端/UI设计优先考虑调用image_gen生成参考图或素材；也支持通用生图/编辑，未配置用/image-gen config。
```

渐进式参数注入设计：

1. 系统提示只注入一句短提示，避免挤占上下文。
2. 工具 schema 只暴露最小 action 与常用参数。
3. 模型不确定时先调用 `action=help`，工具返回完整使用规范。
4. 前端/UI 设计是优先提醒场景，但不限制其他生图场景。
5. 未配置时工具只提示用户运行 `/image-gen config`，不让模型索要密钥。

工具 action：

```text
help      查看完整能力和使用规范
status    查看配置状态
generate  文生图
edit      图生图 / 图片编辑 / 换背景 / 统一风格
```

工具参数：

```text
action           help | generate | edit | status
prompt           生图/编辑提示词
image            edit 输入图：本地路径、URL、data URL 或 base64；会校验 jpeg/png/gif/webp 文件头
output_name      输出文件名
size             可选尺寸覆盖，如 1024x1024
mask             局部重绘遮罩（透明区域被重绘）
quality          auto | low | medium | high | xhigh | max
background       auto | opaque | transparent
output_format    png | jpeg | webp
n                生成张数 1-10
model            可选模型覆盖
```

并行生图：`image_gen` 支持同一轮内并发执行，实际同时请求数由 `/image-gen config -> 设置最大并行数` 或 `IMAGE2_MAX_CONCURRENCY` 控制。默认 1 保持旧行为；调高后适合一次生成多张方案图。

## 用户命令

打开菜单：

```text
/image-gen
```

文生图：

```text
/image-gen generate 一只戴墨镜的橘猫，赛博朋克风
```

不带 prompt 时会打开多行编辑器：

```text
/image-gen generate
```

图生图 / 编辑：

```text
/image-gen edit ./input.png 把背景改成赛博朋克霓虹风，保留主体轮廓
```

也支持：

```text
/image-gen edit --image ./input.png 把背景改成透明
/image-gen edit --image ./input.png --mask ./mask.png 只重绘遮罩区域
```

`mask` 为透明通道遮罩：透明像素处会被重绘，需与输入图同尺寸。

`image` 可以是：

- 本地路径：`./input.png`
- HTTP/HTTPS URL
- `data:image/png;base64,...`
- 裸 base64

查看配置：

```text
/image-gen status
```

帮助：

```text
/image-gen help
```

## 命令结构约束

只注册 `/image-gen` 一个 pi 命令。

命令下一层 action：

- `generate`
- `edit`
- `config`
- `status`
- `help`

配置菜单包含模型 / 尺寸 / 质量 / 背景 / 输出格式 / 输出目录 / 最大并行数 / 连接测试，不新增额外 slash command。

TUI 下最多进入一层表单，不再拆更多 slash command。

## 输出

默认输出目录：

```text
<当前项目>/.image-gen
```

目录会在查看配置、修改输出目录或首次生成图片时自动创建。

接口固定返回 `data[].b64_json`（多张时 `data` 有多条），全部解码保存到输出目录；`output_name` 在多张时会追加 `-1`、`-2` 后缀。

如果后端仍返回普通图片 URL（老的 `url` 响应），插件会下载真实图片保存到 `output_name`，并把完整 JSON 响应另存为 `*-response.json`。
