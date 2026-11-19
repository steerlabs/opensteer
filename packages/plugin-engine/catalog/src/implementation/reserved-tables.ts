/**
 * The tables PluginEngine keeps in an app's database (see `reservedTablePrefix`) as upstream's
 * framework names them, and the SQL rename that gives a plugin's migrations their names here.
 * The names come from the rules data, `upstream-names.json`.
 */
import upstreamNames from "../../../upstream-names.json" with { type: "json" };

/** Each reserved table's earlier name (`from`) and its name now (`to`). */
export const renamedReservedTables: ReadonlyArray<{ readonly from: string; readonly to: string }> =
  upstreamNames.rules.filter((rule) => rule.scope === "reserved-table");

const renamed = new Map(renamedReservedTables.map(({ from, to }) => [from.toLowerCase(), to]));
const identifierStart = /[A-Za-z_\u0080-￿]/u;
const identifierPart = /[A-Za-z0-9_$\u0080-￿]/u;
/** Quoted identifiers: the closing character, which doubles to escape itself (`[` never does). */
const quotes: Record<string, string> = { '"': '"', "`": "`", "[": "]" };

/**
 * `sql` with each complete identifier that names a reserved table by its earlier name, bare or
 * quoted and in any case (SQLite's identifiers ignore ASCII case), given the table's name now.
 * String literals, comments and every other identifier keep their bytes, so the rename never
 * changes data a migration writes, and SQL with no such identifier is returned unchanged.
 */
export const renameReservedTables = (sql: string): string => {
  let output = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    if (char === "'") {
      // A string literal; '' inside it is a quote.
      let end = index + 1;
      while (end < sql.length && !(sql[end] === "'" && sql[end + 1] !== "'"))
        end += sql[end] === "'" ? 2 : 1;
      output += sql.slice(index, end + 1);
      index = end + 1;
    } else if (char === "-" && sql[index + 1] === "-") {
      const end = sql.indexOf("\n", index);
      const stop = end === -1 ? sql.length : end;
      output += sql.slice(index, stop);
      index = stop;
    } else if (char === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      const stop = end === -1 ? sql.length : end + 2;
      output += sql.slice(index, stop);
      index = stop;
    } else if (quotes[char] !== undefined) {
      const close = quotes[char];
      let end = index + 1;
      while (end < sql.length && !(sql[end] === close && (close === "]" || sql[end + 1] !== close)))
        end += close !== "]" && sql[end] === close ? 2 : 1;
      const name = sql.slice(index + 1, end);
      const to = renamed.get(
        (close === "]" ? name : name.replaceAll(close + close, close)).toLowerCase(),
      );
      output += to === undefined ? sql.slice(index, end + 1) : `${char}${to}${close}`;
      index = end + 1;
    } else if (identifierStart.test(char)) {
      let end = index + 1;
      while (end < sql.length && identifierPart.test(sql[end]!)) end += 1;
      const name = sql.slice(index, end);
      output += renamed.get(name.toLowerCase()) ?? name;
      index = end;
    } else {
      output += char;
      index += 1;
    }
  }
  return output;
};
