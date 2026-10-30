import Foundation

/// Catalog data is compiled in as Swift source, so app bundles need no resource bundle.
public enum DataContracts {
  private struct Table: Decodable, Sendable {
    let grants: [String: DataAppGrants]
    let operations: [String: [String: DataOperationContract]]
  }
  private static let table: Table = {
    do { return try JSONDecoder().decode(Table.self, from: Data(ContractTable.json.utf8)) }
    catch { preconditionFailure("Invalid embedded Apple contract table: \(error)") }
  }()
  public static let grants = table.grants
  public static let operations = table.operations
}
