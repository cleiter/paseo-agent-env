import { describe, expect, it } from "vitest";
import { parseEnvOutput } from "./parse";

const PEM = "-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----";

describe("parseEnvOutput", () => {
  it("reads a JSON object and keeps null as unset", () => {
    expect(parseEnvOutput('{"A":"1","B":null,"N":3}\n')).toEqual({ A: "1", B: null, N: "3" });
  });

  it("keeps multi-line values in NUL-delimited output", () => {
    expect(parseEnvOutput(`A=1\0KEY=${PEM}\0`)).toEqual({ A: "1", KEY: PEM });
  });

  it("reads newline-delimited KEY=VALUE and keeps = inside values", () => {
    expect(parseEnvOutput("A=1\nURL=postgres://u:p@h/db?x=y\n")).toEqual({
      A: "1",
      URL: "postgres://u:p@h/db?x=y",
    });
  });

  it("keeps trailing whitespace of the last value", () => {
    expect(parseEnvOutput("A=1\0B=x  ")).toEqual({ A: "1", B: "x  " });
  });

  it("rejects empty output", () => {
    expect(() => parseEnvOutput("  \n")).toThrow("printed no environment");
  });

  it("rejects log lines without quoting them", () => {
    expect(() => parseEnvOutput("loading secret-token\nA=1")).toThrow(
      /^expected KEY=VALUE records on stdout; log to stderr instead$/,
    );
  });

  it("rejects log lines that contain = without quoting them", () => {
    expect(() => parseEnvOutput("Loading config: mode=dev\nA=1")).toThrow(
      /^expected KEY=VALUE records on stdout; log to stderr instead$/,
    );
    // Real names with unusual characters still pass.
    expect(parseEnvOutput("ProgramFiles(x86)=C:\\P\nBASH_FUNC_f%%=() {  :\n")).toEqual({
      "ProgramFiles(x86)": "C:\\P",
      "BASH_FUNC_f%%": "() {  :",
    });
  });

  it("rejects JSON that is not an object of strings", () => {
    expect(() => parseEnvOutput("[1]")).toThrow();
    expect(() => parseEnvOutput('{"A":{"b":1}}')).toThrow("not a string");
  });

  it("rejects NUL bytes in JSON without quoting the value", () => {
    expect(() => parseEnvOutput('{"A":"hunter\\u0000two"}')).toThrow(
      /^environment JSON value for A contains a NUL byte$/,
    );
    expect(() => parseEnvOutput('{"A\\u0000B":"1"}')).toThrow("invalid variable name");
  });
});
