const certificateErrors = new Map([
  ["DEPTH_ZERO_SELF_SIGNED_CERT", "self-signed certificate"],
  ["SELF_SIGNED_CERT_IN_CHAIN", "self-signed certificate in certificate chain"],
  ["CERT_HAS_EXPIRED", "certificate has expired"],
  ["CERT_NOT_YET_VALID", "certificate is not yet valid"],
  ["CERT_REVOKED", "certificate revoked"],
  ["UNABLE_TO_GET_ISSUER_CERT", "unable to get issuer certificate"],
  ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "unable to get local issuer certificate"],
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "unable to verify the first certificate"],
  ["CERT_SIGNATURE_FAILURE", "certificate signature failure"],
  ["CERT_CHAIN_TOO_LONG", "certificate chain too long"],
  ["INVALID_CA", "invalid CA certificate"],
  ["PATH_LENGTH_EXCEEDED", "path length constraint exceeded"],
  ["INVALID_PURPOSE", "unsuitable certificate purpose"],
  ["CERT_UNTRUSTED", "certificate not trusted"],
  ["CERT_REJECTED", "certificate rejected"],
  ["ERROR_IN_CERT_NOT_BEFORE_FIELD", "format error in certificate's notBefore field"],
  ["ERROR_IN_CERT_NOT_AFTER_FIELD", "format error in certificate's notAfter field"],
  ["UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY", "unable to decode issuer public key"],
  ["UNABLE_TO_DECRYPT_CERT_SIGNATURE", "unable to decrypt certificate's signature"],
  ["UNABLE_TO_GET_CRL", "unable to get certificate CRL"],
  ["CRL_NOT_YET_VALID", "CRL is not yet valid"],
  ["CRL_HAS_EXPIRED", "CRL has expired"],
  ["CRL_SIGNATURE_FAILURE", "CRL signature failure"],
  ["UNABLE_TO_DECRYPT_CRL_SIGNATURE", "unable to decrypt CRL's signature"],
  ["ERROR_IN_CRL_LAST_UPDATE_FIELD", "format error in CRL's lastUpdate field"],
  ["ERROR_IN_CRL_NEXT_UPDATE_FIELD", "format error in CRL's nextUpdate field"],
  ["UNHANDLED_CRITICAL_EXTENSION", "unhandled critical extension"],
  ["KEYUSAGE_NO_CERTSIGN", "key usage does not include certificate signing"],
  ["KEYUSAGE_NO_DIGITAL_SIGNATURE", "key usage does not include digital signature"],
  ["EE_KEY_TOO_SMALL", "EE certificate key too weak"],
  ["CA_KEY_TOO_SMALL", "CA certificate key too weak"],
  ["CA_MD_TOO_WEAK", "CA signature digest algorithm too weak"],
  ["UNSUPPORTED_SIGNATURE_ALGORITHM", "Cannot find certificate signature algorithm"],
  ["SIGNATURE_ALGORITHM_MISMATCH", "subject signature algorithm and issuer public key algorithm mismatch"],
  ["SIGNATURE_ALGORITHM_INCONSISTENCY", "cert info signature and signature algorithm mismatch"]
]);
const verificationMessages = new Set(certificateErrors.values());
const systemCaHint = "; if the root CA is installed locally, try running Node.js with --use-system-ca";

export function certificateRejected(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  if (error.code === "ERR_TLS_CERT_ALTNAME_INVALID" ||
    typeof error.code === "string" && certificateErrors.has(error.code)) return true;
  // Nodemailer overwrites Node's verification code with ESOCKET on the same Error.
  if (error.code !== "ESOCKET" || error.message.length > 4096) return false;
  const message = error.message.endsWith(systemCaHint) ? error.message.slice(0, -systemCaHint.length) : error.message;
  if (verificationMessages.has(message)) return true;
  return "reason" in error && typeof error.reason === "string" &&
    "cert" in error && error.cert !== null && typeof error.cert === "object" &&
    (error.reason.startsWith("Host: ") || error.reason.startsWith("IP: ")) &&
    message === `Hostname/IP does not match certificate's altnames: ${error.reason}`;
}
