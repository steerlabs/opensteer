import Foundation

/// Catalog data is embedded in the executable, so app bundles need no resource bundle.
public enum DataContracts {
  private struct Table: Decodable, Sendable {
    let grants: [String: DataAppGrants]
    let operations: [String: [String: DataOperationContract]]
  }
  private static let table: Table = {
    do { return try JSONDecoder().decode(Table.self, from: Data(PackageResources.contracts_json)) }
    catch { preconditionFailure("Invalid embedded Apple contract table: \(error)") }
  }()
  public static let grants = table.grants
  public static let operations = table.operations
}
