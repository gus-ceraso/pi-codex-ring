---
name: imagegen
description: Generate or edit raster images with the image_gen tool when a task needs AI-created bitmap visuals such as photos, illustrations, textures, sprites, mockups, diagrams, or transparent cutouts. Do not use it when SVG, HTML/CSS, canvas, or another editable code-native format better fits the requested asset.
license: Apache-2.0; see LICENSE.txt
---

# Image generation

Use Pi's `image_gen` tool for image generation and editing. It uses the configured Codex subscription account ring and does not require `OPENAI_API_KEY`.

## Choose the right medium

Use `image_gen` for raster-style assets, including photos, illustrations, textures, sprites, product mockups, visual concepts, and image transformations.

Prefer direct project-file editing when the requested result is an SVG, a code-native diagram, HTML/CSS/canvas artwork, or a small change to an existing editable source. For icons, logos, and UI graphics, follow the repository's established medium and design system.

## Select an operation

- **New image:** pass `prompt` and, when needed, `model`.
- **Edit local images:** pass one to five absolute paths in `referenced_image_paths`.
- **Edit conversation images:** pass `num_last_images_to_include` when a target has no stable local path. Use the smallest count that includes every target, up to five.
- Never combine `referenced_image_paths` with `num_last_images_to_include`.
- If no selector can include every target, ask the user to attach the missing images again.
- For multiple distinct assets or variants, make one `image_gen` call per asset or variant.

Treat a request as an edit when the user wants to preserve parts of an existing image while changing other parts. Treat images supplied only for style, mood, composition, or subject reference according to the user's stated intent; identify each image's role in the prompt.

## Choose the image model

Choose the model at call time. The `model` argument is optional; omitting it selects `gpt-image-2.5-flare-2026-09-08`.

- Use **Flare** (`gpt-image-2.5-flare-2026-09-08`) for most work: fast, high-quality generation and editing, drafts, social or creator content, product experiences, visual prototyping, and multiple independent assets.
- Use **Sunburst** (`gpt-image-2.5-sunburst-2026-09-08`) when maximum precision materially matters: polished production assets, exact localized edits, complex layouts, identity-sensitive work, or multi-step edits that must preserve unchanged details.
- Use **GPT Image 2** (`gpt-image-2-2026-04-21`) when the user explicitly requests that model.
- Follow an explicit supported model choice. Otherwise, prefer Flare unless the request justifies Sunburst.
- Never retry a failed image request with another model. Report the failure because the original POST may have consumed image quota.

Do not pass other model IDs.

## Workflow

1. Decide whether raster generation is appropriate.
2. Decide whether the request is a new image or an edit.
3. Identify whether the result is a preview or a project asset.
4. Collect the prompt, exact text, required elements, invariants, and avoid items.
5. Structure the prompt without inventing creative requirements.
6. Call `image_gen` directly unless a missing required image blocks the request.
7. Inspect the result for subject, composition, text, requested changes, and preserved invariants.
8. Iterate with one targeted change at a time when correction is needed.
9. If the result belongs in the project, copy the selected generated file into the workspace and update its consumer. Keep the original unless the user asks to delete it.
10. Report final project paths and the final prompt. Do not add a redundant Markdown image when Pi already displayed the image inline.

Do not overwrite an existing project asset unless the user explicitly requested replacement. Otherwise, create a sibling version such as `hero-v2.png`.

## Prompt shaping

Preserve a detailed user prompt rather than expanding it. If a prompt is generic, add only details that materially improve the requested result. Useful fields include:

```text
Use case: <what the visual accomplishes>
Asset type: <where it will be used>
Primary request: <the user's request>
Input images: <Image 1 role; Image 2 role> (when applicable)
Scene/backdrop: <environment>
Subject: <main subject>
Style/medium: <photo, illustration, 3D, and so on>
Composition/framing: <framing and placement>
Lighting/mood: <lighting and mood>
Color palette: <relevant colors>
Materials/textures: <surface details>
Text (verbatim): "<exact text>"
Constraints: <must keep and must include>
Avoid: <must not include>
```

Use only fields that help. For edits, repeat invariants explicitly: state what may change and what must remain unchanged. For multiple inputs, refer to images by index and describe each role.

Read [prompting guidance](references/prompting.md) for difficult prompts or iterative edits. Read [sample prompts](references/sample-prompts.md) when a concrete scaffold would help.

## Transparency

For a transparent result, request a genuinely transparent background in the prompt and preserve the returned alpha channel. Do not invent unsupported tool parameters.

## Output policy

`image_gen` saves its original PNG automatically under:

```text
~/.pi/agent/image_gen/<normalized-project-root>/<session-id>/<tool-call-id>.png
```

The tool has no destination-path argument. If the user names a destination or the image will be referenced by project code, copy the selected file there after generation. Preview-only images may remain in the automatic location.

## Boundaries

- Do not ask for an API key.
- Do not replace image editing with an ad hoc Python or SDK script unless the user explicitly requests another workflow.
- Do not silently switch models or tools.
- Do not claim that size, quality, masks, output format, or output path are model-facing `image_gen` arguments.
- Do not substitute placeholder SVG/HTML/CSS when the user explicitly requested a generated raster visual.
