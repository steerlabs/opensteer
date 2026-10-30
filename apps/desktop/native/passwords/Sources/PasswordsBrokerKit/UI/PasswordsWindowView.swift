import PasswordsCore
import SwiftUI

/// The Passwords window: setup, the saved passwords and where agents may use
/// them, the switch and the history, or the one sentence that explains why
/// this Mac cannot open them.
public struct PasswordsWindowView: View {
  @ObservedObject var model: PasswordsWindowModel

  public init(model: PasswordsWindowModel) {
    self.model = model
  }

  public var body: some View {
    VStack(spacing: 0) {
      if model.development {
        Text(Copy.developmentBanner)
          .font(.callout.weight(.medium))
          .frame(maxWidth: .infinity)
          .padding(.vertical, 6)
          .background(Color.yellow.opacity(0.35))
      }
      content
    }
    .frame(minWidth: 520, idealWidth: 560, minHeight: 440, idealHeight: 600)
    .sheet(item: $model.sheet) { sheet in
      switch sheet {
      case .add: LoginForm(model: model, editing: nil)
      case .edit(let login): LoginForm(model: model, editing: login)
      case .importing:
        if let flow = model.importFlow { ImportSheet(flow: flow) }
      }
    }
  }

  @ViewBuilder private var content: some View {
    switch model.screen {
    case .updateRequired:
      CenteredScreen(symbol: "lock", title: Copy.appName, lead: Copy.updateRequired) { EmptyView() }
    case .unsupported:
      CenteredScreen(symbol: "lock.slash", title: Copy.appName, lead: Copy.unsupported) { EmptyView() }
    case .unavailable:
      CenteredScreen(symbol: "lock", title: Copy.appName, lead: Copy.notUnlockedSinceRestart) { EmptyView() }
    case .setUp, .settingUp:
      SetUpView(model: model)
    case .setUpDone:
      SetUpDoneView(model: model)
    case .needsReset(let reason):
      NeedsResetView(model: model, reason: reason)
    case .ready:
      ReadyView(model: model)
    }
  }
}

/// Setup, done, needs-reset and unsupported: one centred column.
private struct CenteredScreen<Content: View>: View {
  let symbol: String
  var tint: Color = .secondary
  let title: String
  let lead: String
  @ViewBuilder let content: () -> Content

  var body: some View {
    VStack(spacing: 0) {
      Spacer(minLength: 24)
      VStack(spacing: 20) {
        Image(systemName: symbol)
          .font(.system(size: 40, weight: .regular))
          .foregroundStyle(tint)
        VStack(spacing: 8) {
          Text(title).font(.title2.weight(.semibold))
          Text(lead)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
        }
        content()
      }
      .frame(maxWidth: 400)
      .padding(.horizontal, 32)
      // Twice the room below as above: the column sits a little above the
      // middle, where the eye expects it, rather than under an empty band.
      Spacer(minLength: 24)
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

private struct SetUpView: View {
  @ObservedObject var model: PasswordsWindowModel

  var body: some View {
    CenteredScreen(symbol: "key", title: Copy.appName, lead: Copy.setUpLead) {
      VStack(alignment: .leading, spacing: 10) {
        ForEach(Copy.setUpFacts, id: \.self) { fact in
          Label {
            Text(fact).fixedSize(horizontal: false, vertical: true)
          } icon: {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(14)
      .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(.quaternary.opacity(0.5)))
      Label {
        Text(Copy.setUpNote).fixedSize(horizontal: false, vertical: true)
      } icon: {
        Image(systemName: "info.circle")
      }
      .font(.callout)
      .foregroundStyle(.secondary)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 14)
      if let message = model.message {
        Text(message).foregroundStyle(.orange)
      }
      if model.screen == .settingUp {
        HStack(spacing: 6) {
          ProgressView().controlSize(.small)
          Text(Copy.confirming).foregroundStyle(.secondary)
        }
        .frame(height: 28)
      } else {
        Button(Copy.setUpAction) { Task { await model.setUp() } }
          .buttonStyle(.borderedProminent)
          .controlSize(.large)
          .keyboardShortcut(.defaultAction)
      }
    }
  }
}

private struct SetUpDoneView: View {
  @ObservedObject var model: PasswordsWindowModel

  var body: some View {
    CenteredScreen(symbol: "checkmark.circle.fill", tint: .green, title: Copy.setUpDone, lead: Copy.setUpDoneLead) {
      VStack(spacing: 12) {
        Button(Copy.importPasswords) { model.startImport() }
          .buttonStyle(.borderedProminent)
          .controlSize(.large)
          .keyboardShortcut(.defaultAction)
        HStack(spacing: 8) {
          Button(Copy.addPassword) { model.sheet = .add }
          Button(Copy.done) { model.finishSetup() }
        }
      }
    }
  }
}

private struct NeedsResetView: View {
  @ObservedObject var model: PasswordsWindowModel
  let reason: NeedsReset
  @State private var confirming = false

  private var lead: String {
    switch reason {
    case .otherMac: return Copy.otherMac
    case .damaged: return Copy.damaged
    case .olderVersion: return Copy.olderVersion
    }
  }

  var body: some View {
    CenteredScreen(symbol: "exclamationmark.lock", title: Copy.appName, lead: lead) {
      if let message = model.message {
        Text(message).foregroundStyle(.orange)
      }
      HStack(spacing: 8) {
        if reason == .damaged {
          Button(Copy.tryAgain) { Task { await model.tryAgain() } }
        }
        Button(Copy.startFresh, role: .destructive) { confirming = true }
          .buttonStyle(.borderedProminent)
          .tint(.red)
      }
      .controlSize(.large)
    }
    .confirmationDialog(Copy.startFresh, isPresented: $confirming) {
      Button(Copy.startFresh, role: .destructive) { Task { await model.startFresh() } }
      Button(Copy.cancel, role: .cancel) {}
    } message: {
      Text(Copy.startFreshConfirm)
    }
  }
}

private struct ReadyView: View {
  @ObservedObject var model: PasswordsWindowModel
  @State private var deleting: LoginSummary?

  var body: some View {
    Form {
      Section {
        Toggle(isOn: Binding(get: { model.agentSignIns }, set: { on in Task { await model.setAgentSignIns(on) } })) {
          VStack(alignment: .leading, spacing: 2) {
            Text(Copy.agentSignIns)
            Text(Copy.agentSignInsDetail).font(.callout).foregroundStyle(.secondary)
          }
        }
        .toggleStyle(AccentSwitchStyle())
      }

      Section {
        saved
      } header: {
        HStack(spacing: 12) {
          Text(Copy.savedPasswords)
          Spacer()
          // Adding and importing happen in the visit the list opened.
          if case .shown = model.logins {
            Button(Copy.hidePasswords) { model.hidePasswords() }.modifier(HeaderAction())
            Button(Copy.importShort) { model.startImport() }.modifier(HeaderAction())
            Button(Copy.add) { model.sheet = .add }.modifier(HeaderAction())
          }
        }
      }

      Section(Copy.recentSignIns) {
        if model.activity.isEmpty {
          Text(Copy.noSignIns).foregroundStyle(.secondary)
        } else {
          ForEach(Array(model.activity.enumerated()), id: \.offset) { _, entry in
            ActivityRow(entry: entry)
          }
        }
      }
    }
    .formStyle(.grouped)
    .confirmationDialog(
      deleting.map { Copy.deleteConfirm($0.site, Display.account($0.username)) } ?? "",
      isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
    ) {
      Button(Copy.deleteAction, role: .destructive) {
        if let login = deleting { Task { await model.delete(login) } }
        deleting = nil
      }
      Button(Copy.cancel, role: .cancel) { deleting = nil }
    }
  }

  @ViewBuilder private var saved: some View {
    if let message = model.message {
      Text(message).foregroundStyle(.orange)
    }
    switch model.logins {
    case .hidden:
      HStack {
        Label(Copy.locked, systemImage: "lock.fill").foregroundStyle(.secondary)
        Spacer()
        Button(Copy.showPasswords) { Task { await model.showPasswords() } }
      }
    case .showing:
      HStack(spacing: 6) {
        ProgressView().controlSize(.small)
        Text(Copy.confirming).foregroundStyle(.secondary)
      }
    case .shown(let all):
      TextField(Copy.search, text: $model.search, prompt: Text(Copy.search))
        .textFieldStyle(.roundedBorder)
        .labelsHidden()
      if all.isEmpty {
        Text(Copy.noSavedPasswords).foregroundStyle(.secondary)
      } else if model.visibleLogins.isEmpty {
        Text(Copy.noMatches).foregroundStyle(.secondary)
      } else {
        ForEach(model.visibleLogins) { login in
          LoginRow(
            login: login, edit: { model.sheet = .edit(login) }, delete: { deleting = login },
            remove: { grant in Task { await model.removeGrant(grant) } })
        }
      }
    }
  }
}

/// An action in a section header: the header draws its text secondary, so
/// the action is tinted back to read as one.
private struct HeaderAction: ViewModifier {
  func body(content: Content) -> some View {
    content.buttonStyle(.borderless).foregroundStyle(Color.accentColor)
  }
}

/// A switch that reads on or off at a glance: drawn here, so it shows the
/// accent colour when on even while the window is not in front.
private struct AccentSwitchStyle: ToggleStyle {
  func makeBody(configuration: Configuration) -> some View {
    HStack {
      configuration.label
      Spacer(minLength: 12)
      Button {
        configuration.isOn.toggle()
      } label: {
        ZStack(alignment: configuration.isOn ? .trailing : .leading) {
          Capsule()
            .fill(configuration.isOn ? Color.accentColor : Color.secondary.opacity(0.22))
            .frame(width: 38, height: 22)
          Circle()
            .fill(.white)
            .shadow(color: .black.opacity(0.25), radius: 1, y: 0.5)
            .frame(width: 18, height: 18)
            .padding(2)
        }
        .animation(.easeOut(duration: 0.12), value: configuration.isOn)
      }
      .buttonStyle(.plain)
      .accessibilityRepresentation {
        Toggle(isOn: configuration.$isOn) { configuration.label }
      }
    }
  }
}

/// A saved login, with one line for each Workspace whose agents may use it
/// and Remove beside each.
private struct LoginRow: View {
  let login: LoginSummary
  let edit: () -> Void
  let delete: () -> Void
  let remove: (Grant) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 8) {
        Button(action: edit) {
          HStack(spacing: 10) {
            Monogram(text: login.site)
            VStack(alignment: .leading, spacing: 1) {
              Text(login.site).font(.body.weight(.medium))
              Text([Display.account(login.username), login.label].compactMap { $0 }.joined(separator: " · "))
                .font(.callout)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        Menu {
          Button(Copy.edit, action: edit)
          Button(Copy.delete, role: .destructive, action: delete)
        } label: {
          Image(systemName: "ellipsis.circle")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel(Copy.moreActions)
      }
      ForEach(login.grants, id: \.key) { grant in
        HStack(spacing: 6) {
          Image(systemName: "person.badge.key").foregroundStyle(.secondary).font(.callout)
          Text(Copy.allowedIn(Display.clean(grant.workspaceName, limit: 60), site: Self.otherSite(grant, of: login)))
            .font(.callout)
            .foregroundStyle(.secondary)
          Spacer(minLength: 8)
          Button(Copy.remove) { remove(grant) }
            .modifier(HeaderAction())
            .font(.callout)
        }
        // Lined up under the site's name, past the monogram.
        .padding(.leading, 38)
      }
    }
  }

  /// The grant's site, when it is not the one the row is named for.
  private static func otherSite(_ grant: Grant, of login: LoginSummary) -> String? {
    let host = String(grant.key.site.dropFirst("https://".count))
    return host == login.site ? nil : host
  }
}

/// A site's or an app's first character in a circle: no favicon is fetched.
struct Monogram: View {
  let text: String
  var symbol: String?
  /// Grey rather than a colour of the site's own.
  var neutral = false

  private static let palette: [Color] = [.blue, .indigo, .purple, .pink, .orange, .teal, .green, .brown]

  var body: some View {
    ZStack {
      Circle().fill(neutral ? AnyShapeStyle(.quaternary) : AnyShapeStyle(Self.colour(for: text).gradient))
      if let symbol {
        Image(systemName: symbol).font(.system(size: 13, weight: .semibold))
      } else {
        Text(initial).font(.system(size: 14, weight: .semibold))
      }
    }
    .foregroundStyle(neutral ? AnyShapeStyle(.primary) : AnyShapeStyle(.white))
    .frame(width: 28, height: 28)
    .accessibilityHidden(true)
  }

  private var initial: String {
    text.first(where: { $0.isLetter || $0.isNumber }).map { String($0).uppercased() } ?? "?"
  }

  /// Stable across launches (`hashValue` is not), so a site keeps its colour.
  private static func colour(for text: String) -> Color {
    let sum = text.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) % 1_000_003 }
    return palette[sum % palette.count]
  }
}

private struct ActivityRow: View {
  let entry: ActivityEntry

  var body: some View {
    HStack(alignment: .firstTextBaseline) {
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 6) {
          Text(entry.site).font(.body.weight(.medium))
          OutcomeLabel(outcome: entry.outcome)
          if entry.automatic {
            Text(Copy.automatic).font(.caption).foregroundStyle(.secondary)
          }
        }
        Text(([entry.account].compactMap { $0 } + [entry.workspace, "“\(entry.thread)”"]).joined(separator: " · "))
          .font(.callout)
          .foregroundStyle(.secondary)
      }
      Spacer()
      Text(entry.at.formatted(.relative(presentation: .named))).font(.caption).foregroundStyle(.secondary)
    }
  }
}

private struct OutcomeLabel: View {
  let outcome: ActivityOutcome

  var body: some View {
    let colour = outcome == .signedIn ? Color.green : Color.secondary
    Text(Self.title(outcome))
      .font(.caption.weight(.medium))
      .foregroundStyle(colour)
      .padding(.horizontal, 6)
      .padding(.vertical, 1)
      .background(Capsule().fill(colour.opacity(0.15)))
  }

  static func title(_ outcome: ActivityOutcome) -> String {
    switch outcome {
    case .used: return "Used"
    case .signedIn: return "Signed in"
    case .declined: return "Not allowed"
    case .cancelled: return "Cancelled"
    case .expired: return "Expired"
    case .failed: return "Failed"
    case .wrongPassword: return "Password refused"
    case .outcomeUnknown: return "Couldn’t confirm"
    }
  }
}

/// Add, or Edit one login. Passwords are typed, never shown.
private struct LoginForm: View {
  @ObservedObject var model: PasswordsWindowModel
  let editing: LoginSummary?
  @State private var websites = ""
  @State private var username = ""
  @State private var password = ""
  @State private var twoFactor = ""
  @State private var removeTwoFactor = false
  @State private var label = ""
  @State private var problem: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(editing == nil ? Copy.addTitle : Copy.editTitle).font(.headline).padding([.top, .horizontal], 20)
      Form {
        if editing == nil {
          TextField(Copy.website, text: $websites, prompt: Text("github.com"))
        } else {
          VStack(alignment: .leading) {
            Text(Copy.websites)
            TextEditor(text: $websites).font(.body).frame(minHeight: 54)
            Text(Copy.websitesHelp).font(.caption).foregroundStyle(.secondary)
          }
        }
        TextField(Copy.username, text: $username)
        VStack(alignment: .leading) {
          SecureField(editing == nil ? Copy.password : Copy.newPassword, text: $password)
          if editing != nil {
            Text(Copy.newPasswordHelp).font(.caption).foregroundStyle(.secondary)
          }
        }
        VStack(alignment: .leading) {
          TextField(Copy.twoFactor, text: $twoFactor).disabled(removeTwoFactor)
          Text(Copy.twoFactorHelp).font(.caption).foregroundStyle(.secondary)
          if editing?.hasTOTP == true {
            Toggle(Copy.removeTwoFactor, isOn: $removeTwoFactor)
          }
        }
        TextField(Copy.label, text: $label)
      }
      .formStyle(.grouped)
      if let problem {
        Text(problem).foregroundStyle(.orange).padding(.horizontal, 20)
      }
      HStack {
        if model.working {
          ProgressView().controlSize(.small)
        }
        Spacer()
        Button(Copy.cancel) { model.sheet = nil }.keyboardShortcut(.cancelAction)
        Button(Copy.save) { Task { await save() } }
          .buttonStyle(.borderedProminent)
          .keyboardShortcut(.defaultAction)
          .disabled(model.working)
      }
      .padding(20)
    }
    .frame(width: 460)
    .onAppear {
      guard let editing else { return }
      websites = editing.origins.map { String($0.dropFirst("https://".count)) }.joined(separator: "\n")
      username = editing.username
      label = editing.label ?? ""
    }
  }

  private func save() async {
    let outcome: PasswordsWindowModel.FormOutcome
    if let editing {
      outcome = await model.edit(
        editing, websites: websites, username: username, newPassword: password, twoFactor: twoFactor,
        removeTwoFactor: removeTwoFactor, label: label)
    } else {
      outcome = await model.add(website: websites, username: username, password: password, twoFactor: twoFactor, label: label)
    }
    if case .stays(let sentence) = outcome { problem = sentence }
  }
}
