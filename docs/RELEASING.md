# Releasing BetterGit for macOS

A pushed `v*` tag runs the **Release** workflow on GitHub Actions. It builds an arm64 DMG and creates the GitHub Release for that tag with the DMG attached.

Releases are unsigned for now. Signing and notarization are set up later; see [Signed releases (later)](#signed-releases-later).

## Cut a release

`package.json` holds the version. The tag must match it.

1. Set `"version"` in `package.json`, for example `0.2.0`. Use semver (`X.Y.Z` or `X.Y.Z-beta.1`).
2. Commit and push to `master`:

   ```sh
   git commit -am "chore: release 0.2.0" && git push origin master
   ```

3. Tag that commit and push the tag:

   ```sh
   git tag v0.2.0 && git push origin v0.2.0
   ```

The workflow attaches `BetterGit-0.2.0-arm64.dmg` to the `v0.2.0` release. If the release already exists, the workflow replaces its DMG and leaves the notes alone.

If the tag does not match `package.json`, the build step fails with `expected version '0.2.0' but package.json has '0.1.0'`. Delete the tag, fix `package.json`, commit, and tag again:

```sh
git tag -d v0.2.0 && git push origin :refs/tags/v0.2.0
```

## Unsigned builds

With no signing secrets in the repository, `scripts/release-mac.sh` signs the app ad-hoc and skips notarization. Apple Silicon refuses to run code with no signature at all, so ad-hoc is the minimum. The hardened runtime is off, because under an ad-hoc signature its library validation rejects Electron's frameworks and the app does not start.

The workflow log prints `building an UNSIGNED (ad-hoc) release`, and the release notes tell users how to open the app:

1. Move BetterGit to Applications and try to open it. macOS blocks it.
2. Open **System Settings** > **Privacy & Security**. Under **Security**, click **Open Anyway** and enter your login password. Apple shows the button for about an hour after the blocked attempt ([Apple support](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac)).

Or clear the quarantine flag in Terminal:

```sh
xattr -dr com.apple.quarantine /Applications/BetterGit.app
```

To build the same unsigned DMG on your Mac, run `bun run release:mac` with none of the signing variables set. The DMG lands in `dist/`.

## Signed releases (later)

The workflow signs with a Developer ID Application certificate and notarizes once all five secrets below exist. Set all of them or none. If only some are set, the build fails with `partial signing config` and lists the ones it found.

Setup happens once and involves two people. You hold the private key. A teammate who is the Account Holder of the Apple Developer team issues the certificate and the API key. The teammate never shares their Apple password.

### A. Create the key and the CSR (you)

1. Run the CSR script and enter your name and email when it asks:

   ```sh
   scripts/signing-csr.sh
   ```

   It writes `developer-id.key` and `developer-id.certSigningRequest` to `~/.bettergit-signing` (override with `SIGNING_DIR`). Both files are `chmod 600`.
2. Send `developer-id.certSigningRequest` to the teammate. Do not send `developer-id.key`.

### B. Issue the certificate and the API key (teammate)

Only the Account Holder can create a Developer ID certificate.

1. Create the certificate:
   1. Open [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources) and click **Certificates**.
   2. Click **+**. Under **Software**, select **Developer ID**, then click **Continue**.
   3. Select **Developer ID Application**. If the page asks for a Sub-CA, select **G2 Sub-CA**.
   4. Upload the `.certSigningRequest` file, click **Continue**, then click **Download**.
2. If the team has never used the App Store Connect API, open [App Store Connect](https://appstoreconnect.apple.com) and go to **Users and Access** > **Integrations** > **Request Access**. Apple reviews the request.
3. Create the API key:
   1. In **Users and Access** > **Integrations** > **App Store Connect API**, click **Team Keys**.
   2. Click **Generate API Key** (or **+**). Name it `BetterGit notarization` and set **Access** to **Developer**.
   3. Click **Generate**, then download the `AuthKey_<KEYID>.p8` file. Apple allows one download only.
4. Send back these four items over a private channel:
   - the `.cer` file
   - the `.p8` file
   - the **Key ID** from the key list
   - the **Issuer ID** shown above the key list

Apple does not document the minimum role for notarization. Developer works for most teams. If `notarytool` returns `401` or "unauthorized", revoke the key and generate a new one with **App Manager** access.

### C. Configure GitHub (you)

1. Bundle the certificate with your key:

   ```sh
   scripts/signing-p12.sh ~/Downloads/developerID_application.cer
   ```

   The script checks that the certificate matches your key, adds Apple's Developer ID G2 intermediate, and writes `developer-id.p12` plus a random password in `p12-password.txt`. Add `--import` to also put the identity in your login keychain.
2. Run the `gh secret set` commands the script prints. They read values from files or prompts, so nothing lands in shell history. The workflow uses these secrets:

   | Secret | Value |
   |---|---|
   | `CSC_LINK` | base64 of `developer-id.p12` |
   | `CSC_KEY_PASSWORD` | contents of `p12-password.txt` |
   | `APPLE_API_KEY_P8` | contents of `AuthKey_<KEYID>.p8` |
   | `APPLE_API_KEY_ID` | Key ID |
   | `APPLE_API_ISSUER` | Issuer ID |

3. Move the `.cer` and `.p8` into `~/.bettergit-signing` and delete any copies in Downloads or chat.

The next tag you push produces a signed, notarized and stapled DMG. The release notes no longer carry the unsigned-build instructions.

### Signed release from your Mac

```sh
CSC_LINK=~/.bettergit-signing/developer-id.p12 \
CSC_KEY_PASSWORD="$(cat ~/.bettergit-signing/p12-password.txt)" \
APPLE_API_KEY=~/.bettergit-signing/AuthKey_KEYID.p8 \
APPLE_API_KEY_ID=KEYID APPLE_API_ISSUER=ISSUER-UUID \
bun run release:mac
```

The DMG lands in `dist/`.

## Troubleshooting

- **The build fails with `partial signing config`.** Some signing secrets are set and some are empty. Set the missing ones, or delete all five to go back to unsigned builds.
- **The signed build fails with "skipped macOS application code signing".** electron-builder could not load the identity, and `release-mac.sh` refuses to ship unsigned once secrets are set. Check that `CSC_LINK` holds the base64 `.p12` and that `CSC_KEY_PASSWORD` matches it.
- **`security import` reports "MAC verification failed".** Another tool made the `.p12` with OpenSSL 3 defaults. Rebuild it with `scripts/signing-p12.sh`, which uses the 3DES and SHA-1 format macOS accepts.
- **Notarization status is `Invalid`.** `release-mac.sh` prints the notary log. It usually names an unsigned binary or a missing hardened runtime flag.
- **The DMG needs a rebuild for the same tag.** Re-run the workflow. It replaces the DMG on the existing release.
