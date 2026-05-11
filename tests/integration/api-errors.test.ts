/**
 * Typed application error hierarchy + safeApiError round-trip
 * (post-PRD hardening, item 39 follow-up).
 *
 * Coverage:
 *   - Each subclass carries the right statusCode + code; `name`
 *     reflects the subclass for stack-trace clarity.
 *   - `instanceof` is preserved across the hierarchy
 *     (ValidationError instanceof ApiClientError, etc.).
 *   - safeApiError round-trip: thrown ValidationError → 400 + body
 *     carries message + code; ForbiddenError → 403; NotFoundError →
 *     404; ConflictError → 409. The leak invariant from item 38 is
 *     preserved: no Prisma-internal message can ride through.
 *   - lib/terms migration smoke: recordTerms with an unknown kind
 *     surfaces as a ValidationError (statusCode 400 + code), NOT a
 *     generic Error.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  ApiClientError,
  ValidationError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
} from "@/lib/api-errors";
import { safeApiError } from "@/lib/observability";
import { recordTerms } from "@/lib/terms";
import { superDb } from "@/lib/db";

describe("ApiClientError hierarchy", () => {
  it("ValidationError → 400 with optional code", () => {
    const e = new ValidationError("X is required", "x-required");
    expect(e).toBeInstanceOf(ValidationError);
    expect(e).toBeInstanceOf(ApiClientError);
    expect(e).toBeInstanceOf(Error);
    expect(e.statusCode).toBe(400);
    expect(e.code).toBe("x-required");
    expect(e.name).toBe("ValidationError");
    expect(e.message).toBe("X is required");
  });

  it("ForbiddenError → 403", () => {
    const e = new ForbiddenError("nope", "rbac");
    expect(e.statusCode).toBe(403);
    expect(e.code).toBe("rbac");
    expect(e.name).toBe("ForbiddenError");
  });

  it("NotFoundError → 404", () => {
    const e = new NotFoundError("missing");
    expect(e.statusCode).toBe(404);
    expect(e.code).toBeUndefined();
    expect(e.name).toBe("NotFoundError");
  });

  it("ConflictError → 409", () => {
    const e = new ConflictError("state mismatch", "wrong-state");
    expect(e.statusCode).toBe(409);
    expect(e.code).toBe("wrong-state");
    expect(e.name).toBe("ConflictError");
  });

  it("base class accepts arbitrary 4xx statusCode", () => {
    const e = new ApiClientError("teapot", 418, "tea");
    expect(e.statusCode).toBe(418);
    expect(e.code).toBe("tea");
  });
});

describe("safeApiError round-trip", () => {
  it("ValidationError surfaces at 400 with message + code", async () => {
    const res = safeApiError(new ValidationError("name is required", "name-required"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.error).toBe("name is required");
    expect(body.code).toBe("name-required");
  });

  it("ForbiddenError surfaces at 403", async () => {
    const res = safeApiError(new ForbiddenError("not on this tenant", "wrong-tenant"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.error).toBe("not on this tenant");
    expect(body.code).toBe("wrong-tenant");
  });

  it("NotFoundError surfaces at 404", async () => {
    const res = safeApiError(new NotFoundError("record not found"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("record not found");
  });

  it("ConflictError surfaces at 409", async () => {
    const res = safeApiError(
      new ConflictError("only DRAFT records can be amended in place", "non-draft-amend"),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.code).toBe("non-draft-amend");
  });

  it("plain Error STILL falls through to 500 (leak invariant preserved)", async () => {
    const res = safeApiError(new Error("connection terminated unexpectedly"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("internal error");
    expect(JSON.stringify(body)).not.toContain("connection terminated");
  });
});

describe("lib/terms migration smoke", () => {
  it("recordTerms with unknown kind throws ValidationError (not plain Error)", async () => {
    const tenant = await superDb.tenant.create({
      data: { slug: `errs-${randomUUID().slice(0, 8)}`, name: "errors test" },
    });
    const user = await superDb.user.create({
      data: { email: `${randomUUID().slice(0, 8)}@example.test` },
    });
    const m = await superDb.membership.create({
      data: { tenantId: tenant.id, userId: user.id, role: "FIRM_ADMIN", status: "ACTIVE" },
    });
    try {
      await expect(
        recordTerms({
          tenantId: tenant.id,
          actorMembershipId: m.id,
          // @ts-expect-error — deliberately invalid for the test
          kind: "NOT_A_KIND",
          documentRef: "ref",
          body: "body",
          activate: false,
        }),
      ).rejects.toMatchObject({
        name: "ValidationError",
        statusCode: 400,
        code: "unknown-kind",
      });
    } finally {
      await superDb.tenant.delete({ where: { id: tenant.id } }).catch(() => {});
    }
  });

  it("recordTerms with empty documentRef throws ValidationError(document-ref-required)", async () => {
    const tenant = await superDb.tenant.create({
      data: { slug: `errs-${randomUUID().slice(0, 8)}`, name: "errors test" },
    });
    const user = await superDb.user.create({
      data: { email: `${randomUUID().slice(0, 8)}@example.test` },
    });
    const m = await superDb.membership.create({
      data: { tenantId: tenant.id, userId: user.id, role: "FIRM_ADMIN", status: "ACTIVE" },
    });
    try {
      await expect(
        recordTerms({
          tenantId: tenant.id,
          actorMembershipId: m.id,
          kind: "MSA",
          documentRef: "   ",
          body: "body",
          activate: false,
        }),
      ).rejects.toMatchObject({
        name: "ValidationError",
        statusCode: 400,
        code: "document-ref-required",
      });
    } finally {
      await superDb.tenant.delete({ where: { id: tenant.id } }).catch(() => {});
    }
  });

  it("recordTerms with actor on the wrong tenant throws ForbiddenError(actor-wrong-tenant)", async () => {
    const tenantA = await superDb.tenant.create({
      data: { slug: `errsA-${randomUUID().slice(0, 8)}`, name: "errors test A" },
    });
    const tenantB = await superDb.tenant.create({
      data: { slug: `errsB-${randomUUID().slice(0, 8)}`, name: "errors test B" },
    });
    const user = await superDb.user.create({
      data: { email: `${randomUUID().slice(0, 8)}@example.test` },
    });
    const mB = await superDb.membership.create({
      data: { tenantId: tenantB.id, userId: user.id, role: "FIRM_ADMIN", status: "ACTIVE" },
    });
    try {
      await expect(
        recordTerms({
          tenantId: tenantA.id, // wrong tenant
          actorMembershipId: mB.id,
          kind: "MSA",
          documentRef: "ref",
          body: "body",
          activate: false,
        }),
      ).rejects.toMatchObject({
        name: "ForbiddenError",
        statusCode: 403,
        code: "actor-wrong-tenant",
      });
    } finally {
      await superDb.tenant.delete({ where: { id: tenantA.id } }).catch(() => {});
      await superDb.tenant.delete({ where: { id: tenantB.id } }).catch(() => {});
    }
  });
});
