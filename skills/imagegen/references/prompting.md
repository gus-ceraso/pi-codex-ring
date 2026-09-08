# Image prompting guidance

## Preserve intent

A good prompt clarifies the requested result without replacing the user's taste with arbitrary detail.

- Keep specific prompts specific.
- Add detail to a generic prompt only when it supports the stated use.
- Do not invent characters, objects, brands, slogans, palettes, or narrative events.
- Ask a question only when missing information blocks a required result.

## Build the prompt

A useful order is:

1. intended use and medium;
2. scene or backdrop;
3. subject and defining details;
4. composition and framing;
5. lighting, mood, color, and texture;
6. exact text;
7. constraints and avoid items.

For photorealistic work, use concrete camera, lens, framing, depth-of-field, and lighting language only when it matters. For illustrations, identify the medium, line quality, rendering style, and intended finish.

## Text in images

- Quote required text verbatim.
- State placement, hierarchy, and typography.
- For difficult words, spell them letter by letter and still provide the complete verbatim text.
- Verify every character after generation.

## Edits

State the edit and invariants separately:

```text
Change: replace only the background with a rainy evening street.
Keep unchanged: subject identity, pose, clothing, framing, camera angle, and foreground edges.
Avoid: new people, text, logos, and changes to the subject.
```

Repeat invariants on every follow-up edit. Make one targeted change per iteration to reduce drift.

For multiple inputs, label roles clearly:

```text
Image 1: edit target; preserve its composition and subject.
Image 2: color and lighting reference only.
Image 3: object to composite into Image 1.
```

## Common asset guidance

- **Website hero:** specify aspect and usable negative space only when the layout requires it.
- **Product image:** specify material, camera angle, background, reflections, and branding constraints.
- **Sprite or game asset:** specify viewpoint, silhouette, palette, edge treatment, and consistency requirements.
- **UI mockup:** provide fidelity, platform, content hierarchy, and exact visible copy.
- **Diagram or infographic:** define structure, labels, reading order, and accuracy constraints. Prefer code-native diagrams when deterministic editing matters.
- **Transparent cutout:** request actual transparency, clean edges, no shadow spill, and no checkerboard or painted backdrop.
