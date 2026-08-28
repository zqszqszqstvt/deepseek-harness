# Agent Note: Linux-only multi-user Server

Status: implemented

English | [中文](2026-08-28-server-linux-only.zh.md)

## Problem

The multi-user Server assigns each tenant a workspace and promises that shell and filesystem operations cannot read another tenant's files. Strict filesystem-tool reads and the sandbox permission ceiling cover DSH tool paths, but Bash or PowerShell can read through the host kernel without those filesystem-tool checks. Linux bubblewrap confinement removes other user directories from the shell's mount view. macOS Seatbelt and the Windows ACL runner primarily constrain writes and do not provide the same workspace-only read guarantee.

## Decision

`dsh server` supports Linux only. The startup command rejects every other Node platform before publishing `serverStartup`; the HTTP listener, Server Session persistence, and Server runtime inject that value and therefore cannot activate after rejection. Command help remains available because Commander does not execute the startup action for `--help`.

The restriction belongs to the Server startup provider. Shared sandbox packages, Bash, PowerShell, Web, Headless, and custom profiles retain their existing platform behavior. The Server's sandbox maximum remains an independent defense against approval-based widening, as described by [Server sandbox maximum](2026-08-27-server-sandbox-maximum.md).

## Verification

Startup tests select Linux, Windows, and macOS deterministically. Linux publishes the startup values. Windows and macOS request exit code 1, include the workspace-read reason in the diagnostic, and leave `serverStartup` absent. The existing help test runs under an unsupported test platform and proves help exits without publishing startup values.

## Alternatives considered

**Rely on strict filesystem-tool reads.** Rejected because shell commands do not use the filesystem tool service and can open host paths directly.

**Treat Seatbelt and Windows ACL write restrictions as sufficient isolation.** Rejected because the Server promises tenant read isolation, not only protection against writes.

**Disable shell tools on macOS and Windows.** Rejected because the Server inherits workflows and agent behavior built around shell execution. A platform-specific reduced Server would be a separate product contract and requires its own design and verification.

**Change shared non-Server platform behavior.** Rejected because local Web, Headless, and custom profiles do not make the Server's multi-tenant isolation promise.

## Consequences

Server operators must deploy on Linux with the strict shell sandbox available. macOS and Windows users receive a direct startup failure instead of a reachable Server with incomplete tenant read isolation. Help remains portable, and non-Server profiles lose no platform functionality.
