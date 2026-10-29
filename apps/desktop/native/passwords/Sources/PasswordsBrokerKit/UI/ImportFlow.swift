import Foundation
import PasswordsCore

/// Where the person's passwords are now, and how to get them out.
public enum ImportSource: String, CaseIterable, Identifiable, Sendable {
  case chrome
  case safari
  case firefox
  case onePassword
  case bitwarden
  case other

  public var id: String { rawValue }

  public var title: String {
    switch self {
    case .chrome: return "Chrome, Edge or Brave"
    case .safari: return "Safari or Apple Passwords"
    case .firefox: return "Firefox"
    case .onePassword: return "1Password"
    case .bitwarden: return "Bitwarden"
    case .other: return "Another app (CSV file)"
    }
  }

  /// Short and in the apps' own words, so the person can follow them in
  /// the other window.
  public var steps: [String] {
    switch self {
    case .chrome:
      return [
        "In Chrome, open Google Password Manager and click Settings.",
        "Click Export passwords, then Download file.",
      ]
    case .safari:
      return ["Open the Passwords app and choose File › Export All Passwords to File…."]
    case .firefox:
      return [
        "In Firefox, open the menu (☰) and choose Passwords.",
        "Click the ••• menu and choose Export Passwords….",
      ]
    case .onePassword:
      return [
        "In 1Password, choose File › Export and pick your account.",
        "Choose CSV as the file format.",
      ]
    case .bitwarden:
      return [
        "In Bitwarden, choose File › Export vault (on the web: Tools › Export vault).",
        "Choose .json or .csv. Don’t choose the password-protected format.",
      ]
    case .other:
      return ["Export a CSV file with columns for the website, the username and the password."]
    }
  }

  /// A line under the steps, for the other apps in the same family.
  public var note: String? {
    switch self {
    case .chrome: return "Edge and Brave have the same Export passwords button in their password settings."
    case .safari: return "On macOS 14, use Safari instead: File › Export › Passwords…."
    default: return nil
    }
  }

  public static let fileNote = "The file holds your passwords in plain text. You can delete it after the import."
}

/// The import sheet, step by step:
/// source → how to export → file → (the worker reads it) → preview →
/// import (one commit) → offer to move the file to the Trash.
///
/// It runs inside the window's visit, whose authentication covers the
/// preview and the commit. The broker owns the import itself: the sheet names
/// it by its ID, and the broker ends it with the visit, whatever the sheet
/// shows.
@MainActor
public final class ImportFlow: ObservableObject {
  public enum Stage: Equatable {
    case chooseSource
    case steps(ImportSource)
    case reading(ImportSource)
    case preview(ImportSource, ImportPreview)
    case importing
    case done(count: Int)
    case failed(ImportSource, String)
  }

  @Published public private(set) var stage: Stage = .chooseSource
  @Published public private(set) var file: URL?
  private let broker: Broker
  private let runner: ImportRunner
  private let finished: @MainActor () -> Void
  /// The import this sheet shows, from picking a file until it ends.
  private(set) var importID: ImportID?

  init(broker: Broker, runner: ImportRunner, finished: @escaping @MainActor () -> Void) {
    self.broker = broker
    self.runner = runner
    self.finished = finished
  }

  public func choose(_ source: ImportSource) {
    stage = .steps(source)
  }

  public func back() {
    if case .steps = stage { stage = .chooseSource }
  }

  /// The person picked `url` in the open panel. The worker reads it; the
  /// broker never parses the export itself.
  public func read(_ url: URL, from source: ImportSource) async {
    // Opened before the file is read, so closing the window while the
    // worker runs ends it and the answer prepares nothing.
    guard let id = try? broker.beginImport() else { return close() }
    importID = id
    file = url
    stage = .reading(source)
    // Opened without blocking: a named pipe in place of the export would
    // otherwise hold the main thread until something writes to it.
    guard let descriptor = try? AtomicFile.openRegular(url, O_RDONLY) else {
      return failed(id, source, Copy.couldNotRead)
    }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    let outcome = await runner.run(input: handle)
    try? handle.close()
    let result: ImportResult
    switch outcome {
    case .success(let parsed):
      result = parsed
    case .failure(.refused(let error)):
      return failed(id, source, error.description)
    case .failure(.unreadable):
      return failed(id, source, Copy.couldNotRead)
    }
    do {
      stage = .preview(source, try await broker.prepareImport(result, for: id))
    } catch VaultServiceError.noImport {
      // It ended while the file was read.
      stage = .steps(source)
    } catch {
      stage = .failed(source, Copy.couldNotOpen)
    }
  }

  private func failed(_ id: ImportID, _ source: ImportSource, _ sentence: String) {
    broker.endImport(id)
    stage = .failed(source, sentence)
  }

  public func importNow() async {
    guard case .preview(let source, let preview) = stage, preview.importCount > 0, let id = importID else { return }
    stage = .importing
    do {
      stage = .done(count: try await broker.commitImport(id))
    } catch VaultServiceError.noImport {
      stage = .steps(source)
    } catch VaultError.headMoved {
      stage = .failed(source, Copy.changedElsewhere)
    } catch {
      stage = .failed(source, Copy.couldNotSave)
    }
  }

  /// "Move to Trash" for the export. macOS keeps it in the Trash until the
  /// person empties it; that is the promise and nothing more.
  public func moveFileToTrash() {
    if let file { try? FileManager.default.trashItem(at: file, resultingItemURL: nil) }
    close()
  }

  public func close() {
    if let importID { broker.endImport(importID) }
    finished()
  }

}
