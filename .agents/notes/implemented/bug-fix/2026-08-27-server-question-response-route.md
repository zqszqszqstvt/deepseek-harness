# Agent Note: Server question response route

Status: implemented

English | [中文](2026-08-27-server-question-response-route.zh.md)

## Problem

The multi-user Server streams both approval and question requests through its per-user SSE endpoint, but a platform integration needs an authenticated HTTP operation for each answerable request. An approval answer and an `ask_user_question` answer are different protocols: approvals carry one closed outcome, while questions carry a complete batch of option selections and optional custom text. Sending a question's rpcId through the approval operation produces an approval payload that the gateway rejects, leaving the question and its turn pending.

## Decision

The Server exposes `POST /v1/users/:userId/questions/:rpcId`. Its JSON body is the gateway's complete question answer object, `{ answers: [{ id, selected, custom? }] }`, rather than a single selection. The route derives the session id from `userId`, echoes the path rpcId in a standard `client-response`, places the body under `result.value.answer`, and returns the gateway receipt.

The Server validates only its HTTP envelope and rpcId bound. `ApiProxy.respond()` remains the authority for question ids, answer count and order, duplicate selections, option labels, single-select and multi-select rules, custom text, session ownership, pending state, and duplicate responses. This keeps every transport aligned with the Web client and prevents Server-specific validation from drifting.

## Verification

Server route tests pin multi-question batches, custom text, the URL-derived session id, cross-user rejection, malformed HTTP bodies, and propagation of the gateway's `bad-response` receipt. Existing ApiProxy question tests continue to own semantic answer validation.

## Alternatives considered

**Reuse the approval route.** Rejected because approval outcomes and structured question answers have incompatible payloads and independent pending registries.

**Accept one `{ selected, custom }` answer.** Rejected because one `ask_user_question` call may contain multiple questions and resolves atomically with one complete answer batch.

**Repeat question validation in the Server route.** Rejected because the gateway already owns the pending request and its exact questions; a second implementation could accept or reject different answers from Web and other clients.

## Consequences

Platform backends can answer an SSE `question/requested` frame by posting its rpcId and the complete answer batch to the corresponding user route. A guessed rpcId under another user's route carries the wrong derived session id and is rejected by the gateway. Invalid or late answers return the gateway receipt without settling the pending question.
