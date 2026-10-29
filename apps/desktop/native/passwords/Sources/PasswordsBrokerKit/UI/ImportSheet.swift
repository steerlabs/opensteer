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
      VStack(spacing: 0) {
        ForEach(Array(ImportSource.allCases.enumerated()), id: \.element) { index, source in
          if index > 0 { Divider().padding(.leading, 50) }
          Button { flow.choose(source) } label: {
            HStack(spacing: 10) {
              Monogram(text: source.monogram, symbol: source == .other ? "doc.text" : nil, neutral: true)
              Text(source.title)
              Spacer()
              Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
        }
      }
      .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color(nsColor: .controlBackgroundColor)))
      .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(.separator, lineWidth: 0.5))
      buttons { Button(Copy.cancel) { flow.close() }.keyboardShortcut(.cancelAction) }

    case .steps(let source):
      Text(source.title).font(.subheadline.weight(.semibold))
      VStack(alignment: .leading, spacing: 6) {
        ForEach(Array(source.steps.enumerated()), id: \.offset) { index, step in
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text("\(index + 1).").monospacedDigit().foregroundStyle(.secondary)
            Text(step).fixedSize(horizontal: false, vertical: true)
          }
        }
      }
      if let note = source.note {
        Text(note).fixedSize(horizontal: false, vertical: true)
      }
      Text(ImportSource.fileNote).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      buttons {
        Button(Copy.back) { flow.back() }
        Button(Copy.cancel) { flow.close() }.keyboardShortcut(.cancelAction)
        Button(Copy.chooseFile) { choose(source) }
          .buttonStyle(.borderedProminent)
          .keyboardShortcut(.defaultAction)
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
      Text(Copy.imported(count))
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
    guard panel.runModal() == .OK, let url = panel.url else { return }
    Task { await flow.read(url, from: source) }
  }
}

extension ImportSource {
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
