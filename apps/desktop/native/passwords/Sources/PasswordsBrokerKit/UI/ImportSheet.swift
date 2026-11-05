import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// The import sheet: one question per step.
struct ImportSheet: View {
  @ObservedObject var flow: ImportFlow
  @State private var showSkipped = false

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text(Copy.importTitle).font(.headline)
      stage
    }
    .padding(20)
    .frame(width: 460, alignment: .leading)
  }

  @ViewBuilder private var stage: some View {
    switch flow.stage {
    case .chooseSource:
      Text(Copy.importWhere).foregroundStyle(.secondary)
      SourceList { flow.choose($0) }
      buttons { Button(Copy.cancel) { flow.close() }.keyboardShortcut(.cancelAction) }

    case .steps(let source):
      HStack(spacing: 10) {
        SourceIcon(source: source)
        Text(source.title).font(.subheadline.weight(.semibold))
      }
      VStack(spacing: 0) {
        StepRow(number: 1, text: source.exportStep) {
          if let app = source.appName {
            Button(Copy.open(app)) { source.openForExport() }
          }
        }
        Divider().padding(.leading, 42)
        StepRow(number: 2, text: Copy.chooseExport) {
          Button(Copy.chooseFile) { choose(source) }
            .buttonStyle(.borderedProminent)
            .keyboardShortcut(.defaultAction)
        }
      }
      .modifier(Card())
      if let note = source.note {
        Text(note).font(.callout).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      Label(ImportSource.fileNote, systemImage: "doc.text")
        .font(.callout)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      buttons {
        Button(Copy.back) { flow.back() }
        Button(Copy.cancel) { flow.close() }.keyboardShortcut(.cancelAction)
      }

    case .reading:
      progress(Copy.reading)

    case .preview(_, let preview):
      Text(
        Copy.importCounts(
          new: preview.new, updates: preview.updates, already: preview.alreadySaved, skipped: preview.skipped.count))
      if preview.importCount == 0 {
        Text(Copy.nothingToImport).foregroundStyle(.secondary)
      }
      if !preview.skipped.isEmpty || !preview.leftOut.isEmpty {
        DisclosureGroup(Copy.leftOut, isExpanded: $showSkipped) {
          ScrollView {
            VStack(alignment: .leading, spacing: 2) {
              ForEach(Array(preview.skipped.enumerated()), id: \.offset) { _, row in
                Text(Copy.skippedRow(row.row, row.reason)).font(.callout).foregroundStyle(.secondary)
              }
              ForEach(Array(preview.leftOut.enumerated()), id: \.offset) { _, row in
                Text(Copy.leftOutAddress(row.row, row.reason)).font(.callout).foregroundStyle(.secondary)
              }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
          }
          .frame(maxHeight: 160)
        }
      }
      buttons {
        Button(Copy.cancel) { flow.close() }.keyboardShortcut(.cancelAction)
        if preview.importCount > 0 {
          Button(Copy.importAction(preview.importCount)) { Task { await flow.importNow() } }
            .buttonStyle(.borderedProminent)
            .keyboardShortcut(.defaultAction)
        }
      }

    case .importing:
      progress(Copy.importing)

    case .done(let count):
      Label {
        Text(Copy.imported(count))
      } icon: {
        Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
      }
      Text(Copy.deleteExport).fixedSize(horizontal: false, vertical: true)
      VStack(alignment: .trailing, spacing: 6) {
        buttons {
          Button(Copy.keep) { flow.close() }.keyboardShortcut(.cancelAction)
          Button(Copy.moveToTrash) { flow.moveFileToTrash() }
            .buttonStyle(.borderedProminent)
            .keyboardShortcut(.defaultAction)
        }
        Text(Copy.trashNote).font(.caption).foregroundStyle(.secondary)
      }
      .frame(maxWidth: .infinity, alignment: .trailing)

    case .failed(let source, let message):
      Text(message).fixedSize(horizontal: false, vertical: true)
      buttons {
        Button(Copy.back) { flow.choose(source) }
        Button(Copy.close) { flow.close() }.keyboardShortcut(.defaultAction)
      }
    }
  }

  private func progress(_ text: String) -> some View {
    HStack(spacing: 8) {
      ProgressView().controlSize(.small)
      Text(text).foregroundStyle(.secondary)
    }
  }

  private func buttons<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    HStack {
      Spacer()
      content()
    }
  }

  private func choose(_ source: ImportSource) {
    let panel = NSOpenPanel()
    panel.allowedContentTypes = [.commaSeparatedText, .json]
    panel.allowsMultipleSelection = false
    panel.canChooseDirectories = false
    panel.message = source.title
    // Where browsers put an export, and the first place anyone would look.
    panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
    guard panel.runModal() == .OK, let url = panel.url else { return }
    Task { await flow.read(url, from: source) }
  }
}

/// Where the person's passwords might be: the apps on this Mac first, by their
/// own icons, so the answer is recognized rather than read.
struct SourceList: View {
  let choose: (ImportSource) -> Void
  @State private var sources = ImportSource.onThisMacFirst

  var body: some View {
    VStack(spacing: 0) {
      ForEach(Array(sources.enumerated()), id: \.element) { index, source in
        if index > 0 { Divider().padding(.leading, 50) }
        SourceRow(source: source) { choose(source) }
      }
    }
    .modifier(Card())
  }
}

private struct SourceRow: View {
  let source: ImportSource
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) {
        SourceIcon(source: source)
        Text(source.title)
        Spacer()
        Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 7)
      .contentShape(Rectangle())
      .background(hovering ? Color.primary.opacity(0.05) : .clear)
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
  }
}

private struct SourceIcon: View {
  let source: ImportSource

  var body: some View {
    if let app = source.app {
      Image(nsImage: NSWorkspace.shared.icon(forFile: app.path))
        .resizable()
        .frame(width: 28, height: 28)
        .accessibilityHidden(true)
    } else {
      Monogram(text: source.monogram, symbol: source == .other ? "doc.text" : nil, neutral: true)
    }
  }
}

private struct StepRow<Action: View>: View {
  let number: Int
  let text: String
  @ViewBuilder let action: () -> Action

  var body: some View {
    HStack(spacing: 10) {
      Text("\(number)")
        .font(.caption.weight(.semibold))
        .monospacedDigit()
        .frame(width: 20, height: 20)
        .background(Circle().fill(.quaternary))
      Text(text).fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 8)
      action()
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
  }
}

private struct Card: ViewModifier {
  func body(content: Content) -> some View {
    content
      .background(Color(nsColor: .controlBackgroundColor))
      .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(.separator, lineWidth: 0.5))
  }
}

extension ImportSource {
  /// Sources this Mac has an app for, then the rest; a plain file stays last.
  fileprivate static var onThisMacFirst: [ImportSource] {
    let (here, elsewhere) = allCases.reduce(into: ([ImportSource](), [ImportSource]())) { sorted, source in
      if source.app != nil { sorted.0.append(source) } else { sorted.1.append(source) }
    }
    return here + elsewhere.filter { $0 != .other } + [.other]
  }

  /// The apps this source means, the likeliest first.
  private var bundleIdentifiers: [String] {
    switch self {
    case .chrome: return ["com.google.Chrome", "com.microsoft.edgemac", "com.brave.Browser"]
    case .safari: return ["com.apple.Passwords", "com.apple.Safari"]
    case .firefox: return ["org.mozilla.firefox"]
    case .onePassword: return ["com.1password.1password"]
    case .bitwarden: return ["com.bitwarden.desktop"]
    case .other: return []
    }
  }

  fileprivate var app: URL? {
    bundleIdentifiers.lazy.compactMap { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) }.first
  }

  fileprivate var appName: String? {
    app.map { $0.deletingPathExtension().lastPathComponent }
  }

  /// Opens the app the export happens in, at its export page where Chrome lets
  /// another app ask for one. Elsewhere the step says where to go.
  fileprivate func openForExport() {
    guard let app else { return }
    let configuration = NSWorkspace.OpenConfiguration()
    if Bundle(url: app)?.bundleIdentifier == "com.google.Chrome",
      let page = URL(string: "chrome://password-manager/settings")
    {
      NSWorkspace.shared.open([page], withApplicationAt: app, configuration: configuration)
    } else {
      NSWorkspace.shared.openApplication(at: app, configuration: configuration)
    }
  }

  /// The neutral letter its row shows.
  fileprivate var monogram: String {
    switch self {
    case .chrome: return "C"
    case .safari: return "S"
    case .firefox: return "F"
    case .onePassword: return "1"
    case .bitwarden: return "B"
    case .other: return ""
    }
  }
}
