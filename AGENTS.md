# Agent Instructions

- Browser-facing release downloads must be served through the app's hashtree
  worker/service-worker path. Use same-origin `/htree/...` URLs, preferably
  immutable `nhash` roots with `download=1`, and verify them in Chromium from
  the loaded page.
- Do not replace browser downloads with public hashtree gateway URLs such as
  `https://upload.iris.to/...` as the primary path. Gateway URLs may appear only
  as explicit fallback/debug evidence when the app-origin worker path is still
  the product contract.
