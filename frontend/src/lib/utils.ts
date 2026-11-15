// Class-name merging (clsx + tailwind-merge semantics). Extended so the project's type-scale
// utilities (text-display ... text-micro, see globals.css) count as font sizes, not colours;
// otherwise `cn("text-ui", "text-fg")` would drop one of them.
import { createCn } from "cn/config";

export const cn = createCn({
  extend: {
    classGroups: {
      "font-size": [{ text: ["display", "title", "heading", "lead", "body", "ui", "meta", "micro"] }],
    },
  },
});
