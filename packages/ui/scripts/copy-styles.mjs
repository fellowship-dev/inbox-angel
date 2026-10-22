// Ship the CSS next to the compiled JS: `@inbox-angel/ui/styles.css` etc.
import { cp } from "node:fs/promises";

await cp(new URL("../src/styles", import.meta.url), new URL("../dist/styles", import.meta.url), {
	recursive: true,
});
