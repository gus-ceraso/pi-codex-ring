import { describe, expect, it } from "vitest";
import { identifyAccount, mergeHeaders, sanitizeErrorMessage } from "../src/account.js";
import { jwt } from "./helpers.js";

describe("account identity", () => {
	it("extracts identity and creates stable non-secret fingerprints", () => {
		const first = identifyAccount(jwt("account-a", "user-a"));
		const second = identifyAccount(jwt("account-a", "user-a"));
		const otherUser = identifyAccount(jwt("account-a", "user-b"));
		expect(first).toMatchObject({ accountId: "account-a", userId: "user-a", planType: "plus" });
		expect(first.fingerprint).toMatch(/^[a-f0-9]{24}$/);
		expect(second.fingerprint).toBe(first.fingerprint);
		expect(otherUser.fingerprint).not.toBe(first.fingerprint);
	});

	it("rejects tokens without an account claim", () => {
		const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
		expect(() => identifyAccount(`${encode({})}.${encode({ sub: "user" })}.sig`)).toThrow("account ID");
	});
});

describe("header and error safety", () => {
	it("merges headers case-insensitively and supports deletion", () => {
		expect(
			mergeHeaders(
				{ Authorization: "old", "X-Test": "one" },
				{ authorization: "new", "x-test": null },
			),
		).toEqual({ authorization: "new", "x-test": null });
	});

	it("redacts JWTs and bearer values", () => {
		const token = jwt("account-a");
		const result = sanitizeErrorMessage(`Authorization: Bearer ${token}`);
		expect(result).not.toContain(token);
		expect(result).toContain("[redacted]");
	});
});
