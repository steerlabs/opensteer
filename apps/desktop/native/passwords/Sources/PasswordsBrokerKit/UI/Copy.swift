import Foundation

/// Every sentence the broker shows, and the reasons it writes for the system
/// authentication prompt. Plain words, sentence case, curly ’ and …; buttons
/// in macOS title case; titles end without a period unless they ask. The
/// sentences the web and phone also say are pinned to
/// `packages/client/src/host/passwords.ts` by `CopyParityTests`.
public enum Copy {
  // Shared with packages/client/src/host/passwords.ts.
  public static let appName = "Opensteer Passwords"
  public static let agentSignIns = "Agents can sign in with your passwords"
  public static let setUpLead =
    "Let agents sign in to websites and apps with passwords saved on this Mac. Opensteer never sends your password to the agent; it types it into the website or app, which can read it. You allow an account with Touch ID or your Mac password."
  public static let setUpFacts = [
    "Import from Chrome, Safari, Firefox, 1Password or Bitwarden.",
    "Opensteer fills the fields the agent focuses on, in the browser, on your phone or in Mac apps.",
    "In the browser, each password goes only to its own website. In apps, the agent checks it’s the real app.",
  ]
  /// Under the facts, as a consequence rather than a benefit.
  public static let setUpNote =
    "Passwords are kept only on this Mac and aren’t backed up. If this Mac is lost or erased, ones saved only here are gone."
  public static let setUpAction = "Set Up Passwords"
  public static let unsupported =
    "This Mac can’t keep Opensteer Passwords. It needs Touch ID–class security hardware (Apple silicon, or an Intel Mac with a T2 chip)."
  public static let developmentBanner = "Development build: use test passwords only."

  // What the system authentication prompt says the broker is trying to do:
  // macOS shows "“Opensteer Passwords” is trying to <reason>."
  public static let setUpReason = "set up Opensteer Passwords"
  public static let startFreshReason = "delete the passwords saved on this Mac"
  public static let showReason = "show your saved passwords"
  private static let appConsentRisk =
    "A tricked agent could expose your password."
  public static func allowReason(
    workspace: String, site: String, username: String, permissionVersion: Int64 = 4
  ) -> String {
    let reason = "let agents in \(workspace) sign in to \(site) as \(username)"
    return permissionVersion == 5
      ? "\(reason) on websites and in apps your agents use. \(appConsentRisk)" : reason
  }
  public static func onceReason(
    site: String, username: String, permissionVersion: Int64 = 4
  ) -> String {
    let reason = "sign in to \(site) as \(username) once"
    return permissionVersion == 5
      ? "\(reason) on websites and in apps your agents use. \(appConsentRisk)" : reason
  }
  public static func repointReason(site: String) -> String {
    "change the website or username saved for \(site)"
  }

  // The card shows these when Allow or Only this time did not go through.
  public static let notConfirmed = "Touch ID or your password didn’t match. Try again."
  public static let authenticationCancelled = "Touch ID was cancelled. Try again when you’re ready."
  public static let cannotAuthenticate =
    "This Mac can’t check Touch ID or your password right now. Try again later."
  // Said with the accounts offered again, when the one chosen changed or went.
  public static let accountChanged = "That account changed. Choose it again."
  public static let accountGone = "That account is no longer saved for this site."
  public static let notOffered = "That account isn’t offered for this sign-in. Choose another."
  public static let signInMovedOn = "This sign-in already moved on."
  public static let signInEnded = "This sign-in has ended."
  public static let notReadyForSignIn = "Opensteer Passwords isn’t set up on this Mac."
  public static let couldNotOpenForSignIn =
    "Opensteer Passwords couldn’t open the saved passwords. Ask your agent to try again."
  public static let notUnlockedSinceRestart = "Unlock this Mac to use Opensteer Passwords."
  // A grant's names when the Host's had nothing to show.
  public static let unnamedWorkspace = "Unnamed Workspace"
  public static let unnamedDeployment = "Unnamed Deployment"

  // The Passwords window.
  public static let agentSignInsDetail =
    "Agents use only the accounts you allowed for their Workspace. Sign-ins can stay saved in the browser profile."
  public static let confirming = "Confirm with Touch ID or your Mac password."
  public static let setUpDone = "You’re all set"
  public static let setUpDoneLead = "Add the passwords agents may use."
  public static let importPasswords = "Import Passwords…"
  public static let addPassword = "Add a Password"
  public static let done = "Done"
  public static let savedPasswords = "Saved passwords"
  public static let locked = "Your saved passwords are hidden"
  public static let showPasswords = "Show Passwords"
  public static let hidePasswords = "Hide"
  public static let noSavedPasswords = "No saved passwords yet."
  public static let noMatches = "No saved passwords match."
  public static let search = "Search"
  public static let add = "Add…"
  public static let importShort = "Import…"
  public static let edit = "Edit…"
  public static let delete = "Delete…"
  public static let moreActions = "More"
  public static let deleteAction = "Delete"
  public static let cancel = "Cancel"
  public static let save = "Save"
  /// One line per Workspace allowed to use a login, each with Remove; the
  /// site is named only when it is not the login's own.
  public static func allowedIn(_ workspace: String, site: String?) -> String {
    site.map { "Allowed for agents in: \(workspace), on \($0)" }
      ?? "Allowed for agents in: \(workspace)"
  }
  public static let remove = "Remove"
  public static let recentSignIns = "Recent sign-ins"
  public static let noSignIns = "No sign-ins yet."
  public static let automatic = "Automatic"
  public static let otherMac =
    "These saved passwords came from another Mac and can’t be opened here."
  public static let damaged =
    "Opensteer Passwords can’t open the saved passwords on this Mac. They may have been changed or damaged."
  public static let olderVersion =
    "These saved passwords were set up by an earlier version of Opensteer Passwords. Set up Opensteer Passwords again."
  public static let startFresh = "Start Fresh"
  public static let startFreshConfirm =
    "This permanently deletes the passwords saved on this Mac. Ones you added or changed here can’t be recovered unless you also keep them somewhere else."
  public static let tryAgain = "Try Again"
  public static func deleteConfirm(_ site: String, _ account: String) -> String {
    "Delete the saved password for \(account) on \(site)?"
  }

  // Forms.
  public static let website = "Website"
  public static let websites = "Websites"
  public static let websitesHelp = "One website per line, such as github.com."
  public static let username = "Username"
  public static let password = "Password"
  public static let newPassword = "New password"
  public static let newPasswordHelp = "Leave empty to keep the saved password."
  public static let twoFactor = "Two-factor setup key (optional)"
  public static let twoFactorHelp =
    "The key or otpauth:// link the site showed when you turned on two-factor codes."
  public static let removeTwoFactor = "Remove the two-factor setup key"
  public static let label = "Label (optional)"
  public static let addTitle = "Add a Password"
  public static let editTitle = "Edit Password"

  // Problems the person can fix.
  public static let badWebsite = "Enter a website address such as github.com. It has to use https."
  public static let tooManyWebsites = "A saved password can have at most 8 websites."
  public static let noPassword = "Enter a password."
  public static let tooLong = "One of the fields is too long."
  public static let badTwoFactor = "That two-factor setup key isn’t one Opensteer can use."
  public static let couldNotOpen =
    "Opensteer Passwords couldn’t open the saved passwords. Try again."
  public static let couldNotSave = "Opensteer Passwords couldn’t save that. Try again."
  public static let changedElsewhere =
    "The saved passwords changed while you were looking. Try again."

  // Import.
  public static let importTitle = "Import Passwords"
  public static let importWhere = "Where are your passwords now?"
  public static let chooseFile = "Choose File…"
  public static let reading = "Reading the file…"
  public static let couldNotRead = "Opensteer couldn’t read that file."
  /// Only the counts that are not zero: "5 new · 1 already saved · 6 skipped".
  public static func importCounts(new: Int, updates: Int, already: Int, skipped: Int) -> String {
    [
      new > 0 ? "\(new) new" : nil,
      updates > 0 ? "\(updates) update\(updates == 1 ? "" : "s")" : nil,
      already > 0 ? "\(already) already saved" : nil, skipped > 0 ? "\(skipped) skipped" : nil,
    ].compactMap { $0 }.joined(separator: " · ")
  }
  public static func importAction(_ count: Int) -> String {
    "Import \(count) Password\(count == 1 ? "" : "s")"
  }
  public static let nothingToImport =
    "Everything in this file is already saved, or can’t be imported."
  public static let leftOut = "What was left out"
  public static func skippedRow(_ row: Int, _ reason: String) -> String { "Row \(row): \(reason)" }
  public static func leftOutAddress(_ row: Int, _ reason: String) -> String {
    "Row \(row), one web address: \(reason)"
  }
  public static let importing = "Importing…"
  public static func imported(_ count: Int) -> String {
    "Done. \(count) password\(count == 1 ? " was" : "s were") imported."
  }
  public static let deleteExport =
    "Delete the export file? It contains your passwords in plain text."
  public static let moveToTrash = "Move to Trash"
  public static let trashNote = "It stays in the Trash until you empty it."
  public static let keep = "Keep"
  public static let back = "Back"
  public static let close = "Close"
}
