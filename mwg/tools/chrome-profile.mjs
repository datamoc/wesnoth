import fs from 'node:fs';
import path from 'node:path';

/**
 * The Chrome profile directory a verification run can actually use.
 *
 * Both verify tools give Chrome a fixed `--user-data-dir` under the project root.
 * That is fine until a run dies with its browser still alive: the leftover process
 * keeps the directory locked, the delete raises `EPERM` on Windows, and a new
 * Chrome started on the same directory refuses to open it (the singleton lock),
 * so the gate fails for a reason that has nothing to do with the game. This has
 * cost verification passes here, and the `-<port>` profiles left in the tree are
 * the manual workaround.
 *
 * So: retry the delete (Windows often holds a dead browser's files for a few
 * hundred milliseconds), and when the directory still cannot be cleared, fall
 * back to a fresh sibling named after the process. A locked profile then costs
 * some disk space instead of the whole run.
 *
 * @param {string} dir the wanted profile directory
 * @returns {string} a directory that is empty and safe to hand to Chrome
 */
export function usableProfileDir(dir) {
	const attempts = 3;
	for (let attempt = 1; ; attempt++) {
		try {
			fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
			return dir;
		} catch (error) {
			if (attempt >= attempts) {
				const fresh = `${dir}-${process.pid}`;
				fs.rmSync(fresh, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
				console.error(
					`verify: ${path.basename(dir)} is still held by another browser, using ${path.basename(fresh)} instead`,
				);
				return fresh;
			}
		}
	}
}

/**
 * Best-effort cleanup of the directory `usableProfileDir` returned. A locked
 * profile is left behind, never reported as a failure: it is ignored by git and
 * the next run works around it.
 *
 * @param {string} dir
 */
export function releaseProfileDir(dir) {
	try {
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
	} catch {
		// a locked profile is harmless; it is ignored by git
	}
}
