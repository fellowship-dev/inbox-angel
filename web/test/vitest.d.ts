import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

// Augment this package's own vitest (the workspace root hoists a different major, which jest-dom/vitest would patch instead).
declare module "vitest" {
	// biome-ignore lint: declaration merging
	interface Assertion<T = any> extends TestingLibraryMatchers<unknown, T> {}
	interface AsymmetricMatchersContaining extends TestingLibraryMatchers<unknown, any> {}
}
