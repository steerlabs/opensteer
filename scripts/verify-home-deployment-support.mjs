export function quote(value) {
  return "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
}

export function redact(value) {
  return String(value).replace(/(#token=)[\w.-]+/gu, "$1[redacted]");
}
