'use strict';
// Request shapes for the Hostinger routes.
//
// Only the SHAPE of a request lives here — is this a string, is this object
// present, is this a uuid. Whether the operation exists, whether the operator
// may call it, and whether the parameters make sense for THAT operation are
// decided against the catalogue in operations.service.js, which is the only
// place that knows. Splitting them this way is what keeps a generic
// `/operations/read` endpoint from being a generic proxy: this file accepts
// "an operation id and some objects", and the service accepts only what the
// allow-list names.

const { z } = require('zod');
const { s } = require('../../../lib/hostinger/catalog');

/**
 * A Hostinger API token, as pasted from hPanel → API.
 *
 * The length floor is the only real check available: the format is opaque and
 * undocumented, and a token that is the wrong length is caught by the live
 * verification that runs before storage anyway. The ceiling and the no-space
 * rule exist so a pasted paragraph (or a whole page of notes) fails here with
 * a clear message instead of being encrypted and sent.
 */
const token = z
  .string()
  .trim()
  .min(20, 'too short to be a Hostinger API token')
  .max(512, 'too long to be a Hostinger API token')
  .refine((v) => !/\s/.test(v), 'a token contains no whitespace');

/** A free-text label for the credential row. */
const label = z.string().trim().max(80).optional();

/** Any object of parameters. Bounded so a body cannot be used as storage. */
const params = z
  .object({
    path: z.record(z.string(), z.unknown()).optional(),
    query: z.record(z.string(), z.unknown()).optional(),
    body: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** Write-only credentials, re-supplied at execute time and never stored. */
const secrets = z.record(z.string(), z.string().max(256)).optional();

const limit = z.coerce.number().int().min(1).max(200).optional();
const offset = z.coerce.number().int().min(0).optional();

module.exports = {
  credentialSchemas: {
    connect: { body: z.object({ token, label }).strict() },
    ask: {
      body: z.object({
        question: z.string().trim().min(3).max(4000),
      }).strict(),
    },
  },

  paramsSchemas: {
    read: {
      body: z.object({ operation: z.string().trim().min(3).max(120), params }).strict(),
    },
    plan: {
      body: z.object({ operation: z.string().trim().min(3).max(120), params }).strict(),
    },
    execute: {
      body: z.object({
        operation: z.string().trim().min(3).max(120),
        approval_id: z.uuid(),
        // The destructive gate. Optional here because only destructive
        // operations require it, and the service is the side that knows which
        // — a 400 from here would fire before the operator had a chance to
        // learn what to type.
        confirmation: z.string().max(120).optional(),
        secrets,
      }).strict(),
    },
  },

  pathSchemas: {
    vps: { params: z.object({ virtualMachineId: s.intId }).strict() },
    dockerProject: {
      params: z.object({ virtualMachineId: s.intId, projectName: s.projectName }).strict(),
    },
    websiteFiles: {
      params: z.object({ username: s.accountUser, domain: s.domainName }).strict(),
      query: z.object({
        directory: z.string().max(1024).optional(),
        path: z.string().max(1024).optional(),
        from_line: z.coerce.number().int().min(0).optional(),
        max_lines: z.coerce.number().int().min(1).max(5000).optional(),
      }),
    },
    approvalId: { params: z.object({ id: z.uuid() }).strict() },
  },

  listSchemas: {
    history: {
      query: z.object({
        limit,
        offset,
        action: z.string().trim().max(120).optional(),
      }),
    },
    approvals: { query: z.object({ limit }) },
  },
};
