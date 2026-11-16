/**
 * TEST ONLY. Licence-signing key trusted only by test builds (wxt build --mode e2e),
 * so the e2e tests can unlock Pro. Production builds never trust it.
 */
export const TEST_LICENCE_PRIVATE_JWK: JsonWebKey = {
  "kty": "EC",
  "crv": "P-256",
  "x": "KJv9l1zO3DuwePzGGTH5nd-6IYNwJtfvouLpSvXOUi0",
  "y": "C-YAd8TGzQLwiX0--uZm_MsakUEYdyhe-1E6hlcOkWE",
  "d": "K05MFSFAPa44cqSqq0aJmEZb9zl0fDMFKi0u9SkncjU"
};
