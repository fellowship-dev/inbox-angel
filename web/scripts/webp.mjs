// Chromium cannot write WebP screenshots: re-encode the PNG through a canvas, lowering quality until it fits.
export async function toWebp(page, png, maxBytes = 145_000) {
	return page.evaluate(
		async ([data, max]) => {
			const img = new Image();
			img.src = 'data:image/png;base64,' + data;
			await img.decode();
			const c = document.createElement('canvas');
			c.width = img.width;
			c.height = img.height;
			c.getContext('2d').drawImage(img, 0, 0);
			let blob;
			for (const q of [0.82, 0.7, 0.6, 0.5, 0.4, 0.3]) {
				blob = await new Promise((r) => c.toBlob(r, 'image/webp', q));
				if (blob.size <= max) break;
			}
			const buf = new Uint8Array(await blob.arrayBuffer());
			let bin = '';
			for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
			return btoa(bin);
		},
		[png.toString('base64'), maxBytes],
	).then((b64) => Buffer.from(b64, 'base64'));
}
