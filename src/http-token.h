#pragma once

#include <QByteArray>
#include <QString>
#include <functional>

// The bearer token of the local HTTP server, ported from CielWin's
// AlertHttpTokenFile (CielWin/CielWin.App/Alerts/AlertHttpTokenFile.cs).
//
// Created once on first use and kept forever after: an existing valid token is
// read back UNCHANGED, so every caller that was ever handed it keeps working
// across restarts. A missing, empty or malformed file is replaced with a fresh
// one. The token is 32 CSPRNG bytes as unpadded base64url: exactly 43 characters
// of [A-Za-z0-9_-], safe in an `Authorization: Bearer` header as is.
//
// Linux specifics: the directory is created 0700 and the file is written 0600
// (an existing valid file with looser bits is tightened, never rewritten). The
// write is temp-file-then-rename in the same directory, so a crash leaves the old
// complete token or the new complete one. The whole read-validate-create sequence
// runs under an flock(2) on `<path>.lock` (CielWin: a named mutex), bounded to 5 s.
//
// Never throws or aborts: every failure reports one diagnostic and returns an
// empty token, and the caller leaves the server off. No diagnostic ever contains
// the token value.
namespace HttpToken {
constexpr int length = 43;
constexpr int randomBytes = 32;
// $XDG_STATE_HOME/cielinux/http.token; a relative or empty XDG_STATE_HOME is
// ignored (XDG spec) in favour of $HOME/.local/state.
QString resolvePath(const QByteArray &xdgStateHome, const QByteArray &home);
QString resolvePath(); // From the process environment.
// Trimmed of surrounding whitespace by the caller; exactly 43 base64url characters.
bool isValid(const QByteArray &value);
QByteArray loadOrCreate(const QString &path, const std::function<void(const QString &)> &diagnostic = {});
}
