import AppKit
import Foundation

/// The helper, as one object: the socket, the sessions, the overlay, and the
/// clocks that make it go away again.
///
/// It is the control plane and lives on the main actor with the overlay.
/// Accessibility reads and posted events run on the work executor
/// (`WorkActor`); passive capture runs in its own bounded lane. That lets
/// the pill's `Stop`, `session.close`,
/// `session.open` and `hello` answer at once while an app is not answering.
@MainActor
public final class HelperRuntime {
  public nonisolated static let protocolVersion = 10
  /// Protocol 10 addresses windows explicitly and separates observation from input.
  public nonisolated static let minProtocolVersion = 10
  /// No session and no connection for this long and the helper quits; the
  /// desktop relaunches it on demand.
  static let processIdleTimeout: TimeInterval = 15 * 60
  /// A session nothing has used for this long closes itself, so a lost answer
  /// cannot leave the Mac busy forever.
  static let sessionIdleTimeout: TimeInterval = 10 * 60
  static let tickInterval: TimeInterval = 5

  /// The calls answered outside the serial work lane.
  ///
  /// Session work is answered in the order it arrived, which keeps `observe`
  /// and `act` coherent. Opening and ending a session are bookkeeping that the
  /// person's `Stop`, and the Host's own close, must not wait behind, and
  /// passive permission reads keep the desktop's health checks alive while a
  /// batch runs. The data plane never touches an app's interface: each app it
  /// serves is its own lane (`DataProvider`), so a contact search never waits
  /// behind an observation, nor one app behind another. `hello` is answered on
  /// the connection itself, before any of these.
  nonisolated static let outOfBandMethods: Set<String> = [
    "display.resolve", "display.start", "display.demand", "display.refresh", "display.stop",
    "display.attach", "display.input-reset", "display.input",
    "view.open", "view.activate", "view.renew", "view.close",
    "permissions.get", "session.open", "session.close",
    "data.status", "data.request", "data.invoke",
    "imessage.account", "imessage.poll", "imessage.send",
  ]

  /// Apps one session may hold on one Mac (`computerUseMaxSessionApps`).
  static let maxSessionApps = 8

  public let helperVersion: String
  private let peerRequirement: PeerRequirementMode
  private let catalog: AppCatalog
  private let monitor = WindowMonitor()
  private var overlay: OverlayController?
  private var server: IPCServer?

  private var connections: [Int: IPCConnection] = [:]
  private var closedConnectionIDs: Set<Int> = []
  let registry = SessionRegistry()
  nonisolated let executor = SerialTaskChain()
  private let captureTargets = CaptureTargetStore()
  private let ownerViews = OwnerViewRegistry()
  private var appMutations: [String: AppMutationCoordinator] = [:]
  private(set) var ownerAttachments: [String: MacOwnerAttachment] = [:]
  var videoProducerFactory: MacWindowVideoRegistry.ProducerFactory?
  private lazy var video = MacWindowVideoRegistry(
    makeProducer: videoProducerFactory,
    retainBinding: { [unowned self] target in
      self.captureTargets.contains(target) || self.ownerViews.contains(target)
    }
  ) { [unowned self] source, connection in
    try self.resolveVideo(source, connection: connection)
  }
  private var videoTicker: Timer?
  private var sleepObservers: [any NSObjectProtocol] = []
  private let dataPlane: DataPlane
  private let imessage: IMessageChannel
  /// `data.invoke` calls under way, which a pending restart waits for.
  private var appCallsInFlight = 0
  /// `Stop` ends the session at once; the Run learns it on its next call.
  private var stoppedSessions: [String: Date] = [:]
  private var idleSince: Date? = Date()
  private var ticker: Timer?
  /// ScreenCaptureKit reads the Screen Recording grant at process start, so the
  /// first time it is granted the helper has to be restarted to use it.
  private var quitOnceIdleReason: String?
  private var lastPermissions: PermissionsState?

  private let permissions: @Sendable () -> PermissionsState
  private let appRunning: @Sendable (String, String) -> Bool

  public convenience init(
    helperVersion: String, peerRequirement: PeerRequirementMode,
    catalog: AppCatalog = AppCatalog(), dataPlane: DataPlane = .standard(),
    imessage: IMessageChannel = .standard()
  ) {
    self.init(
      helperVersion: helperVersion, peerRequirement: peerRequirement,
      catalog: catalog, dataPlane: dataPlane, imessage: imessage,
      permissions: { Permissions.current() },
      appRunning: { AppProcess.anyInstanceRunning(bundleId: $0, path: $1) })
  }

  init(
    helperVersion: String,
    peerRequirement: PeerRequirementMode,
    catalog: AppCatalog = AppCatalog(),
    dataPlane: DataPlane = .standard(),
    imessage: IMessageChannel = .standard(),
    permissions: @escaping @Sendable () -> PermissionsState,
    appRunning: @escaping @Sendable (String, String) -> Bool = {
      AppProcess.anyInstanceRunning(bundleId: $0, path: $1)
    }
  ) {
    self.permissions = permissions
    self.appRunning = appRunning
    self.helperVersion = helperVersion
    self.peerRequirement = peerRequirement
    self.catalog = catalog
    self.dataPlane = dataPlane
    self.imessage = imessage
  }

  // MARK: - Lifecycle

  public func start(socketURL: URL = HelperPaths.socket) throws {
    _ = PrivateAPI.windowGroupsAvailable
    lastPermissions = permissions()
    // Full Disk Access switched on after launch reaches this process only
    // from its next launch, so the helper restarts once nothing is under way.
    let runtime = self
    Task {
      await FullDiskAccessGrant.shared.whenGrantedAfterLaunch {
        Task { @MainActor in
          runtime.restartForGrant(
            "Full Disk Access was granted; restarting so reads can see it.")
        }
      }
    }
    let overlay = OverlayController(onStop: { [weak self] in self?.stopFromOverlay() })
    self.overlay = overlay
    // The drawn pointer and outline follow the windows they sit on.
    monitor.onWindowEvent = { [weak overlay] in
      Task { @MainActor in overlay?.windowsChanged() }
    }
    monitor.start()
    let server = IPCServer(
      socketURL: socketURL,
      verifier: PeerVerifier(mode: peerRequirement),
      onFrame: { [weak self] connection, frame in
        self?.receive(connection: connection, frame: frame)
      },
      onConnectionClosed: { [weak self] connection in
        Task { @MainActor in self?.connectionClosed(connection) }
      }
    )
    try server.start()
    self.server = server

    let timer = Timer.scheduledTimer(withTimeInterval: Self.tickInterval, repeats: true) {
      [weak self] _ in
      MainActor.assumeIsolated { self?.tick() }
    }
    RunLoop.main.add(timer, forMode: .common)
    ticker = timer
    let videoTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.video.tick(); self?.tickOwnerInput() }
    }
    RunLoop.main.add(videoTimer, forMode: .common)
    videoTicker = videoTimer
    for (name, sleeping) in [
      (NSWorkspace.willSleepNotification, true), (NSWorkspace.didWakeNotification, false),
    ] {
      sleepObservers.append(
        NSWorkspace.shared.notificationCenter.addObserver(forName: name, object: nil, queue: .main)
        { [weak self] _ in
          MainActor.assumeIsolated {
            self?.video.setSleeping(sleeping)
            if sleeping { self?.releaseAllOwnerInput(reason: "secure-lock") }
          }
        })
    }
  }

  /// Routes one frame, on the connection's read queue, in the order frames
  /// arrived.
  ///
  /// `hello` is answered right here, so the frame after it always finds the
  /// connection greeted. Bookkeeping goes to the main actor at once. Work
  /// joins the serial lane with its deadline, counted from now: when that
  /// passes while the work still waits, it is refused as not done.
  nonisolated func receive(connection: IPCConnection, frame: Data) {
    let receivedAt = Date()
    guard let envelope = try? JSONCoding.decoder.decode(RequestEnvelope.self, from: frame) else {
      connection.send(
        response: .failure(
          id: .null,
          error: HelperError(.failed, "That message was not a request this helper understands.")
        )
      )
      return
    }
    guard connection.isGreeted else {
      greet(connection: connection, envelope: envelope)
      return
    }
    let deadline: Date?
    do {
      deadline = try envelope.deadline(receivedAt: receivedAt)
    } catch let error as HelperError {
      connection.send(response: .failure(id: envelope.id, error: error))
      return
    } catch {
      return
    }

    // `HelperRuntime` is main-actor isolated; only the reference crosses into
    // these tasks, and `perform` itself always runs on the main actor.
    let runtime = self
    if envelope.method == "hello" || Self.outOfBandMethods.contains(envelope.method) {
      Task { @MainActor in
        await runtime.answer(connection: connection, envelope: envelope, deadline: deadline)
      }
      return
    }
    let work = QueuedWork()
    if let deadline {
      DispatchQueue.global(qos: .userInitiated).asyncAfter(
        wallDeadline: .now() + max(0, deadline.timeIntervalSinceNow)
      ) {
        if work.expire() {
          connection.send(response: .failure(id: envelope.id, error: QueuedWork.expired))
        }
      }
    }
    executor.enqueue {
      guard work.start() else { return }
      await runtime.answer(connection: connection, envelope: envelope, deadline: deadline)
    }
  }

  public func stop() {
    releaseAllOwnerInput(reason: "stream-lost")
    video.close()
    videoTicker?.invalidate()
    videoTicker = nil
    for observer in sleepObservers {
      NSWorkspace.shared.notificationCenter.removeObserver(observer)
    }
    sleepObservers.removeAll()
    ticker?.invalidate()
    ticker = nil
    closeAllSessions(reason: nil)
    monitor.stop()
    server?.stop()
    server = nil
  }

  // MARK: - Frames

  /// One frame, answered now rather than routed: what `receive` does for a
  /// frame once it has been let through, and what tests drive directly.
  func handle(connection: IPCConnection, frame: Data) async {
    guard let envelope = try? JSONCoding.decoder.decode(RequestEnvelope.self, from: frame) else {
      connection.send(
        response: .failure(
          id: .null,
          error: HelperError(.failed, "That message was not a request this helper understands.")
        )
      )
      return
    }
    guard connection.isGreeted else {
      greet(connection: connection, envelope: envelope)
      return
    }
    let deadline: Date?
    do {
      deadline = try envelope.deadline(receivedAt: Date())
    } catch let error as HelperError {
      connection.send(response: .failure(id: envelope.id, error: error))
      return
    } catch {
      return
    }
    await answer(connection: connection, envelope: envelope, deadline: deadline)
  }

  private func answer(connection: IPCConnection, envelope: RequestEnvelope, deadline: Date?)
    async
  {
    guard !closedConnectionIDs.contains(connection.id) else { return }
    connections[connection.id] = connection
    idleSince = nil
    do {
      let result = try await perform(
        method: envelope.method, envelope: envelope, connection: connection,
        budget: WorkBudget(requestEnd: deadline))
      connection.send(response: .success(id: envelope.id, result: result))
      if envelope.method == "display.attach" {
        connection.enableMedia()
        video.attachmentReady(connection)
      }
    } catch let error as HelperError {
      connection.send(response: .failure(id: envelope.id, error: error))
    } catch {
      connection.send(
        response: .failure(
          id: envelope.id,
          error: HelperError(.failed, "This Mac could not complete that request.")
        )
      )
    }
  }

  /// The first frame on a connection. It touches nothing the main actor
  /// owns, so it is answered on the connection's own queue, ahead of every
  /// frame after it.
  private nonisolated func greet(connection: IPCConnection, envelope: RequestEnvelope) {
    guard envelope.method == "hello" else {
      connection.send(
        response: .failure(
          id: envelope.id,
          error: HelperError(.failed, "The first message on a connection must be hello.")
        )
      )
      connection.close()
      return
    }
    guard let params = try? envelope.params.decoded(as: Wire.HelloParams.self) else {
      connection.send(
        response: .failure(
          id: envelope.id,
          error: HelperError(.incompatibleVersion, "This helper could not read that hello.")
        )
      )
      connection.close()
      return
    }
    guard
      params.protocolVersion >= Self.minProtocolVersion,
      params.protocolVersion <= Self.protocolVersion
    else {
      connection.send(
        response: .failure(
          id: envelope.id,
          error: HelperError(
            .incompatibleVersion,
            "This Mac's Opensteer Computer Use speaks protocol "
              + "\(Self.minProtocolVersion)–\(Self.protocolVersion); update Opensteer."
          )
        )
      )
      connection.close()
      return
    }
    connection.markGreeted(
      protocolVersion: params.protocolVersion,
      ownerViewVersion: params.ownerViewVersion == 3 ? 3 : nil, loginText: params.loginText,
      ownerInputVersion: params.ownerInputVersion == 2 ? 2 : nil)
    connection.send(
      response: .success(
        id: envelope.id,
        result: Wire.HelloResult(
          loginText: connection.loginReceiver?.key,
          ownerViewVersion: params.ownerViewVersion == 3 ? 3 : nil,
          ownerInputVersion: params.ownerInputVersion == 2 ? 2 : nil,
          helperVersion: helperVersion,
          minProtocolVersion: Self.minProtocolVersion,
          permissions: permissions(),
          protocolVersion: Self.protocolVersion,
          routes: Wire.HelloResult.Routes(
            windowLocation: PrivateAPI.backgroundPointerDeliveryAvailable,
            windowGroups: PrivateAPI.windowGroupsAvailable
          )
        )
      )
    )
    let runtime = self
    Task { @MainActor in runtime.greeted(connection) }
  }

  private func greeted(_ connection: IPCConnection) {
    guard !closedConnectionIDs.contains(connection.id) else { return }
    connections[connection.id] = connection
    idleSince = nil
  }

  private func perform(
    method: String,
    envelope: RequestEnvelope,
    connection: IPCConnection,
    budget: WorkBudget
  ) async throws -> any Encodable {
    switch method {
    case "hello":
      throw HelperError(.failed, "This connection has already said hello.")
    case "permissions.get":
      return Wire.PermissionsResult(permissions: refreshPermissions(deferRestart: true))
    case "permissions.request":
      let params = try envelope.decodeParams(Wire.PermissionsRequestParams.self, method: method)
      let pane = try params.validatedPane()
      return Wire.PermissionsResult(permissions: requestPermissions(pane: pane))
    case "apps.installed":
      return await catalog.installed(
        try envelope.decodeParams(Wire.InstalledAppsParams.self, method: method))
    case "app.resolve":
      let params = try envelope.decodeParams(Wire.ResolveParams.self, method: method)
      let record = try await catalog.resolve(query: params.app)
      return Wire.ResolveAppResult(app: AppResolver.resolved(record))
    case "display.input-reset":
      return try await resetOwnerInput(envelope, connection: connection)
    case "display.input":
      return try await ownerInput(envelope, connection: connection, budget: budget)
    case "display.start":
      return try await video.start(envelope, connection: connection, budget: budget)
    case "display.resolve", "display.demand", "display.refresh", "display.stop", "display.attach":
      let result = try video.perform(envelope, connection: connection)
      tickOwnerInput()
      for attachment in ownerAttachments.values where !attachment.active.current {
        await waitForOwnerCleanup(attachment)
      }
      return result
    case "view.windows":
      let params = try envelope.decodeParams(Wire.OwnerWindowsParams.self, method: method)
      let verdict = AppPolicy.verdict(for: params.app.bundleId)
      guard verdict.allowed else { throw HelperError(.appNotAllowed, verdict.reason) }
      let record = try await catalog.verifiedRecord(for: params.app)
      return Wire.OwnerWindowsResult(
        windows: try await SessionWindows.ownerWindows(record: record, budget: budget).windows)
    case "session.windows", "session.bind":
      let requested: SessionApp
      let sessionID: String
      let window: CGWindowID?
      if method == "session.bind" {
        let params = try envelope.decodeParams(Wire.BindParams.self, method: method)
        requested = params.app
        sessionID = params.sessionId
        window = params.window
      } else {
        let params = try envelope.decodeParams(Wire.WindowsParams.self, method: method)
        requested = params.app
        sessionID = params.sessionId
        window = nil
      }
      let opened = try session(sessionID, connection: connection)
      try Self.requireUnlocked()
      let state = try await appState(opened, requested, needsControl: false)
      let cancellation = opened.cancellation
      let inventory = try await SessionWindows.windows(
        app: state, monitor: monitor, budget: budget,
        check: { try cancellation.check() },
        processAcquired: { pid in
          try await MainActor.run {
            try Self.validateObservationCommit(
              current: self.registry.sessions[sessionID], expected: opened, app: state,
              connectionID: connection.id)
            if let old = opened.processIdentifiers[state.key], old != pid {
              self.monitor.forget(processIdentifier: old)
            }
            opened.processIdentifiers[state.key] = pid
            try cancellation.check(); try budget.check()
          }
        })
      try Self.validateObservationCommit(
        current: registry.sessions[sessionID], expected: opened, app: state,
        connectionID: connection.id)
      if method == "session.windows" { return Wire.WindowsResult(windows: inventory) }
      let selected = try await SessionWindows.bind(app: state, window: window, monitor: monitor,
        check: { try cancellation.check(); try budget.check() })
      try await publishCurrent(of: state, in: opened, connectionID: connection.id)
      return Wire.BindResult(window: selected)
    case "view.open", "view.activate", "view.renew", "view.close":
      guard connection.negotiatedOwnerViewVersion == 3 else {
        throw HelperError(
          .unsupported, "Negotiate owner-view version 3 before opening an owner view.")
      }
      let params = try envelope.decodeParams(Wire.ViewParams.self, method: method)
      return try await ownerView(
        method: method, params: params, connection: connection, budget: budget)
    case "session.open":
      return try openSession(
        params: try envelope.decodeParams(Wire.SessionOpenParams.self, method: method),
        connection: connection
      )
    case "session.close":
      let params = try envelope.decodeParams(Wire.SessionParams.self, method: method)
      try closeRequestedSession(params.sessionId, connection: connection)
      return Wire.EmptyResult()
    case "session.observe":
      let params = try envelope.decodeParams(Wire.ObserveParams.self, method: method)
      return Wire.ObservationResult(
        observation: try await observe(params: params, connection: connection, budget: budget)
      )
    case "session.act":
      let params = try envelope.decodeParams(Wire.ActParams.self, method: method)
      return try await act(params: params, connection: connection, budget: budget)
    case "data.status":
      return Wire.DataStatusResult(grants: await dataPlane.grantReader.current())
    case "data.request":
      let params = try envelope.decodeParams(Wire.DataRequestParams.self, method: method)
      // A question on the person's screen is work under way: a restart for a
      // grant waits for it rather than taking it down.
      appCallsInFlight += 1
      defer {
        appCallsInFlight -= 1
        if quitOnceIdleReason != nil {
          DispatchQueue.main.async { [weak self] in self?.restartIfGrantPending() }
        }
      }
      let grants = await dataPlane.grantReader.request(params.grant)
      // Nobody can ask for Full Disk Access; asking means the person may have
      // switched it on. A process that still cannot read has a fresh one look,
      // whatever the child probe said.
      if params.grant == .fullDiskAccess, grants.fullDiskAccess != .granted {
        restartForGrant("Checking Full Disk Access again in a fresh process.")
      }
      return Wire.DataStatusResult(grants: grants)
    case "data.invoke":
      let params = try envelope.decodeParams(Wire.DataInvokeParams.self, method: method)
      appCallsInFlight += 1
      defer {
        appCallsInFlight -= 1
        if quitOnceIdleReason != nil {
          // After this call's answer has been written.
          DispatchQueue.main.async { [weak self] in self?.restartIfGrantPending() }
        }
      }
      return Wire.DataInvokeResult(value: try await dataPlane.invoke(params, budget: budget))
    case "imessage.account":
      return try await imessage.account()
    case "imessage.poll":
      let params = try envelope.decodeParams(Wire.IMessagePollParams.self, method: method)
      return try await imessage.poll(
        owner: params.owner, accountId: params.accountId, after: params.after,
        limit: params.limit)
    case "imessage.send":
      let params = try envelope.decodeParams(Wire.IMessageSendParams.self, method: method)
      appCallsInFlight += 1
      defer {
        appCallsInFlight -= 1
        if quitOnceIdleReason != nil {
          DispatchQueue.main.async { [weak self] in self?.restartIfGrantPending() }
        }
      }
      return try await imessage.send(
        owner: params.owner, accountId: params.accountId, key: params.key, to: params.to,
        text: params.text, budget: budget)
    default:
      throw HelperError(.unsupported, "This helper has no \(method).")
    }
  }

  // MARK: - Permissions

  private func requestPermissions(pane: PermissionPane?) -> PermissionsState {
    refreshPermissions(Permissions.request(pane: pane), deferRestart: true)
  }

  @discardableResult
  private func refreshPermissions(
    _ current: PermissionsState? = nil,
    deferRestart: Bool
  ) -> PermissionsState {
    let current = current ?? permissions()
    let before = lastPermissions ?? current
    lastPermissions = current
    let transition = Self.permissionTransition(from: before, to: current)

    if transition.restartForScreenRecording {
      quitOnceIdleReason =
        "Screen Recording was granted; restarting so ScreenCaptureKit can see it."
      Log.permissions.notice(
        "macOS Screen Recording was granted; the helper will restart once no session is open."
      )
      if deferRestart {
        // After the answer to this very request has been written. The desktop
        // keeps its connection open to poll permissions, so waiting for the
        // connection to go away would mean waiting forever.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
          self?.restartIfGrantPending()
        }
      }
    }
    return current
  }

  public struct PermissionTransition: Equatable, Sendable {
    public let restartForScreenRecording: Bool
  }

  public nonisolated static func permissionTransition(
    from previous: PermissionsState,
    to current: PermissionsState
  ) -> PermissionTransition {
    PermissionTransition(
      restartForScreenRecording: previous.screenRecording == .denied
        && current.screenRecording == .granted
    )
  }

  /// Whether the process has to go, now that a grant has changed.
  ///
  /// ScreenCaptureKit reads the Screen Recording grant at process start, so a
  /// helper that was running when the person granted it can never capture; the
  /// desktop relaunches it and the person sees nothing. Work under way is the
  /// only reason to wait — a live session, which it would be rude to leave
  /// mid-batch, and an app call, whose change would be left unknown — and an
  /// open connection is not, because the desktop always has one.
  public enum RestartDecision: Equatable, Sendable {
    case stay
    case restart
  }

  public nonisolated static func restartDecision(
    grantPending: Bool, sessionActive: Bool, appCallsInFlight: Bool
  ) -> RestartDecision {
    grantPending && !sessionActive && !appCallsInFlight ? .restart : .stay
  }

  /// A grant this process can only use after a restart: the restart waits for
  /// whatever is under way, as Screen Recording's does.
  private func restartForGrant(_ reason: String) {
    if quitOnceIdleReason == nil { quitOnceIdleReason = reason }
    Log.permissions.notice("\(reason, privacy: .public)")
    // After the answer to the request that found it has been written.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
      self?.restartIfGrantPending()
    }
  }

  private func restartIfGrantPending() {
    guard let reason = quitOnceIdleReason,
      Self.restartDecision(
        grantPending: true, sessionActive: !registry.sessions.isEmpty,
        appCallsInFlight: appCallsInFlight > 0) == .restart
    else { return }
    Log.lifecycle.notice("Quitting: \(reason, privacy: .public)")
    // Every connection is closed first so the desktop sees the socket go and
    // reconnects, rather than waiting on a process that is on its way out.
    server?.stop()
    server = nil
    NSApplication.shared.terminate(nil)
  }

  // MARK: - Sessions

  private func session(_ sessionId: String, connection: IPCConnection) throws -> HelperSession {
    if let stoppedAt = stoppedSessions[sessionId], Date().timeIntervalSince(stoppedAt) < 3_600 {
      throw HelperError(.stoppedByUser, "The person stopped this session on their Mac.")
    }
    guard let session = registry.sessions[sessionId] else {
      throw HelperError(.noSession, "That session is no longer open on this Mac.")
    }
    guard session.connectionID == connection.id else {
      throw HelperError(.noSession, "That session belongs to another connection.")
    }
    session.lastUsedAt = Date()
    return session
  }

  /// Bookkeeping only: it names the session and the task the pill shows. It
  /// claims nothing, resolves nothing and waits on nothing, so it is never
  /// `busy` and never slow.
  private func openSession(
    params: Wire.SessionOpenParams,
    connection: IPCConnection
  ) throws -> Wire.SessionOpenResult {
    guard !closedConnectionIDs.contains(connection.id) else {
      throw HelperError(.noSession, "That connection closed before the session opened.")
    }
    if let stoppedAt = stoppedSessions[params.sessionId],
      Date().timeIntervalSince(stoppedAt) < 3_600
    {
      throw HelperError(.stoppedByUser, "The person stopped this session on their Mac.")
    }
    if params.runId != nil, connection.loginReceiver == nil { throw LoginEnvelopeCrypto.refusal }
    if let existing = registry.sessions[params.sessionId] {
      guard existing.connectionID == connection.id else {
        throw HelperError(.noSession, "That session belongs to another connection.")
      }
      guard existing.runId == params.runId else { throw LoginEnvelopeCrypto.refusal }
      existing.lastUsedAt = Date()
      existing.threadTitle = params.threadTitle
      updateOverlay()
      return Wire.SessionOpenResult(sessionId: existing.sessionId)
    }
    if quitOnceIdleReason != nil, registry.sessions.isEmpty {
      throw HelperError(
        .permissionRequired,
        "Opensteer Computer Use is restarting to finish Screen Recording setup.")
    }
    let opened = HelperSession(
      sessionId: params.sessionId, connectionID: connection.id, threadTitle: params.threadTitle,
      runId: params.runId)
    registry.insert(opened)
    idleSince = nil
    updateOverlay()
    Log.session.notice("Opened a session.")
    return Wire.SessionOpenResult(sessionId: opened.sessionId)
  }

  func isMonitoring(_ pid: pid_t) -> Bool { monitor.isWatching(pid) }

  private func updateOverlay(ending: OverlayModel.Ending = .ended) {
    let ownerInput = ownerAttachments.values.filter { $0.active.current }.map { lease in
      OverlayModel.Session(id: lease.id, threadTitle: nil,
        apps: [.init(key: lease.binding.target.app.bundleId.lowercased(), name: lease.binding.target.app.displayName,
          access: .readWrite, path: lease.path)], ownerInput: true)
    }
    overlay?.update(sessions: registry.sessions.values, owners: registry.owners, ending: ending, ownerInput: ownerInput)
  }

  private func closeAllSessions(reason: SessionStoppedReason?) {
    for id in Array(registry.sessions.keys) {
      closeSession(id, reason: reason, overlayEnding: nil)
    }
    updateOverlay(ending: reason == .user ? .stopped : .ended)
  }

  /// `overlayEnding` is nil while several sessions close at once; the caller
  /// then updates the overlay once, so its notice names every Thread that
  /// ended together.
  private func closeSession(
    _ id: String, reason: SessionStoppedReason?, overlayEnding: OverlayModel.Ending? = .ended
  ) {
    guard let closing = registry.remove(id, reason: reason == .user ? .stoppedByUser : .closed)
    else { return }
    captureTargets.remove(id)
    for app in closing.apps.values { app.focus.stop() }
    for processIdentifier in closing.processIdentifiers.values {
      monitor.forget(processIdentifier: processIdentifier)
    }
    if let overlayEnding { updateOverlay(ending: overlayEnding) }
    if let reason {
      // Only the person's Stop earns `stopped-by-user` on later calls. A
      // session that ended because its app quit is simply gone: a call that
      // was already on its way gets `no-session`, not a claim the person
      // stopped the task.
      if reason == .user { stoppedSessions[closing.sessionId] = Date() }
      connections[closing.connectionID]?.send(
        event: EventEnvelope(
          event: HelperEvent.sessionStopped,
          params: SessionStoppedParams(reason: reason, sessionId: closing.sessionId)
        )
      )
    }
    idleSince = connections.isEmpty ? Date() : nil
    Log.session.notice("Closed the session.")
    if quitOnceIdleReason != nil {
      // Scheduled rather than immediate so the answer to whatever closed the
      // session goes out before the process does.
      DispatchQueue.main.async { [weak self] in self?.restartIfGrantPending() }
    }
  }

  private func closeRequestedSession(_ sessionId: String, connection: IPCConnection) throws {
    guard let current = registry.sessions[sessionId], current.connectionID == connection.id
    else {
      _ = try session(sessionId, connection: connection)
      return
    }
    closeSession(sessionId, reason: nil)
  }

  func stopFromOverlay() {
    Log.session.notice("The person pressed Stop.")
    for attachment in ownerAttachments.values {
      if let id = attachment.source.viewId, let generation = attachment.source.generation {
        try? ownerViews.close(id, generation: generation, connectionID: attachment.connection.id)
      }
    }
    releaseAllOwnerInput(reason: "stopped")
    closeAllSessions(reason: .user)
  }

  nonisolated static func requireUnlocked(
    locked: Bool =
      (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Bool
      == true
  ) throws {
    if locked {
      throw HelperError(.unsupported, "The Mac is locked; ask the person to unlock it.")
    }
  }

  // MARK: - The app a call targets

  static let readOnly = HelperError(.unsupported, "This app is approved as Can see only.")

  /// The app one observe or act targets, in this session.
  ///
  /// The call carries the identity and access the Host resolved. The deny list
  /// and the access are enforced on every call; the identity is resolved and
  /// verified against the installed bundle the first time the session uses
  /// the app, and again whenever the Host sends a different identity for it.
  /// The live process is verified by every observe and every action.
  func appState(
    _ session: HelperSession,
    _ requested: SessionApp,
    needsControl: Bool
  ) async throws -> AppSessionState {
    let key = requested.identity.bundleId.lowercased()
    let verdict = AppPolicy.verdict(for: requested.identity.bundleId)
    guard verdict.allowed else { throw HelperError(.appNotAllowed, verdict.reason) }
    if needsControl, requested.access != .readWrite { throw Self.readOnly }
    try registry.requireAvailable(key, for: session)

    if let cached = session.app(key), AppCatalog.sameIdentity(cached.identity, requested.identity) {
      try registry.claim(cached, for: session)
      session.noteAccess(requested.access, for: cached)
      updateOverlay()
      return cached
    }

    guard session.app(key) != nil || session.apps.count < Self.maxSessionApps else {
      throw HelperError(
        .unsupported, "A session can use at most \(Self.maxSessionApps) apps on one Mac.")
    }
    let record = try await catalog.verifiedRecord(for: requested.identity)
    // The session may have been stopped or closed while the bundle was read.
    try session.cancellation.check()
    guard registry.sessions[session.sessionId] === session else {
      throw HelperError(.noSession, "That session is no longer open on this Mac.")
    }
    let state = AppSessionState(identity: record.identity, path: record.path,
      mutations: mutations(for: key))
    if let replaced = session.app(key) {
      if let processIdentifier = session.processIdentifiers[key] {
        monitor.forget(processIdentifier: processIdentifier)
      }
      session.remove(replaced)
    }
    try registry.claim(state, for: session)
    session.add(state, access: requested.access)
    updateOverlay()
    return state
  }

  // MARK: - Observe and act

  private func ownerView(
    method: String, params: Wire.ViewParams, connection: IPCConnection, budget: WorkBudget
  ) async throws -> any Encodable {
    func state(_ view: OwnerViewRegistry.View, closed: Bool = false) -> Wire.ViewStateResult {
      Wire.ViewStateResult(
        viewId: view.id, generation: view.generation, state: closed ? "closed" : "ready",
        captureTargetId: closed ? nil : view.captureTargetId,
        window: closed ? nil : view.windowSummary)
    }
    func opened(_ view: OwnerViewRegistry.View) -> any Encodable {
      guard view.target != nil else {
        return Wire.ViewUnavailableResult(
          viewId: view.id, generation: view.generation, kind: "unavailable",
          reason: view.unavailableReason)
      }
      return state(view)
    }
    if method == "view.close" {
      try ownerViews.close(
        params.viewId, generation: params.generation, connectionID: connection.id)
      return Wire.ViewStateResult(
        viewId: params.viewId, generation: params.generation, state: "closed", captureTargetId: nil)
    }
    if method == "view.renew" {
      return opened(
        try ownerViews.renew(
          params.viewId, generation: params.generation, leaseDurationMs: params.leaseDurationMs,
          connectionID: connection.id))
    }
    if method == "view.open" {
      guard let target = params.target, target.kind == "app" else {
        throw HelperError(.unsupported, "This Mac views approved apps only.")
      }
      let verdict = AppPolicy.verdict(for: target.app.bundleId)
      guard verdict.allowed else { throw HelperError(.appNotAllowed, verdict.reason) }
      let view = try ownerViews.open(
        id: params.viewId, generation: params.generation, leaseDurationMs: params.leaseDurationMs,
        app: target.app,
        connectionID: connection.id, windowID: target.window)
      if view.prepared { return opened(view) }
      view.prepared = true
      let record = try await catalog.verifiedRecord(for: target.app)
      guard
        (try? ownerViews.require(view.id, generation: view.generation, connectionID: connection.id))
          === view,
        !budget.requestExpiredNow
      else { throw HelperError(.noSession, "That owner view ended while opening.") }
      let cancellation = view.cancellation
      do {
        let binding = try await OwnerViewWindow.open(
          record: record, windowID: target.window, cancellation: cancellation, budget: budget)
        view.window = binding
        view.target = binding.target
        view.windowSummary = await binding.summary()
      } catch let error as OwnerViewWindow.Failure {
        view.unavailableReason = error.reason
      } catch let error as HelperError {
        if error.code == .appNotAllowed { throw error }
        view.unavailableReason =
          error.code == .permissionRequired
          ? "permission-required"
          : error.code == .appNotRunning || error.code == .appNotFound
            ? "window-closed" : "window-unreadable"
      }
      guard
        (try? ownerViews.require(view.id, generation: view.generation, connectionID: connection.id))
          === view,
        !closedConnectionIDs.contains(connection.id)
      else { throw HelperError(.noSession, "That owner view ended while opening.") }
      if let binding = view.window { _ = video.register(binding) }
      return opened(view)
    }
    let view = try ownerViews.require(
      params.viewId, generation: params.generation, connectionID: connection.id)
    if method == "view.activate" {
      guard let app = params.app, AppCatalog.sameIdentity(app, view.app), let target = view.target,
        target.process.isCurrent
      else { throw HelperError(.noSession, "That exact app is no longer available.") }
      let record = try await catalog.verifiedRecord(for: app)
      guard
        (try? ownerViews.require(view.id, generation: view.generation, connectionID: connection.id))
          === view,
        let running = NSRunningApplication(processIdentifier: target.process.processIdentifier),
        AppCatalog.runningApplication(running, matches: view.app, bundlePath: record.path),
        !budget.requestExpiredNow
      else { throw HelperError(.appNotAllowed, "The approved app changed.") }
      guard running.activate(options: []) else {
        throw HelperError(.failed, "The app could not be brought forward.")
      }
      return state(view)
    }
    throw HelperError(.unsupported, "That owner-view operation is not supported.")
  }

  private func observe(
    params: Wire.ObserveParams,
    connection: IPCConnection,
    budget: WorkBudget
  ) async throws -> Observation {
    let includeScreenshot = try Wire.screenshotDecision(
      params.includeScreenshot)
    let opened = try session(params.sessionId, connection: connection)
    try Self.requireUnlocked()
    let state = try await appState(opened, params.app, needsControl: false)
    overlay?.workStarted(on: state)
    defer { overlay?.workEnded(on: state) }
    let cancellation = opened.cancellation
    let observation = try await AppObserver.observe(
      app: state, window: params.window, monitor: monitor, budget: budget,
      includeScreenshot: includeScreenshot, cancellation: cancellation,
      check: { try cancellation.check() })
    try await commit(observation, of: state, in: opened, connectionID: connection.id)
    return observation
  }

  private func act(
    params: Wire.ActParams,
    connection: IPCConnection,
    budget: WorkBudget
  ) async throws -> Wire.ActResult {
    let session = try session(params.sessionId, connection: connection)
    try session.cancellation.check()
    try budget.check()
    let savedBatch: PreparedLoginBatch?
    if params.actions.contains(where: {
      if case .savedText = $0 { return true }
      return false
    }) {
      guard !connection.closedFlag, let receiver = connection.loginReceiver else {
        throw HelperError(.unsupported, "Update Opensteer to type saved login text on this Mac.")
      }
      savedBatch = try receiver.prepare(
        actions: params.actions, context: params.loginContext,
        sessionId: session.sessionId, runId: session.runId)
    } else {
      savedBatch = nil
    }
    try Self.requireUnlocked()
    let state = try await appState(session, params.app, needsControl: true)
    overlay?.workStarted(on: state)
    defer { overlay?.workEnded(on: state) }
    // The stop signal is taken from the session as it stands now; it outlives
    // the session object, so a close part way through still reaches the batch.
    let cancellation = session.cancellation
    let run = try await ActionRunner.run(
      actions: params.actions,
      app: state,
      window: params.window, snapshot: params.snapshot,
      cancellation: cancellation,
      monitor: monitor,
      overlay: overlay,
      budget: budget,
      accessibility: .live,
      savedBatch: savedBatch
    )

    return await Self.finishAct(run, cancellation: cancellation) {
      try await self.publishCurrent(of: state, in: session, connectionID: connection.id)
    }
  }

  static func finishAct(
    _ run: ActionRunner.RunResult, cancellation: SessionCancellation,
    publish: () async throws -> Void
  ) async -> Wire.ActResult {
    var publicationFailure: HelperError?
    do { if cancellation.reason == nil { try await publish() } } catch let error as HelperError {
      publicationFailure = error
    } catch {
      publicationFailure = HelperError(
        .failed, "The input completed but its view could not be updated.")
    }
    return Wire.ActResult(
      performed: run.performed,
      error: (run.error ?? cancellation.reason?.error ?? publicationFailure).map(
        Wire.ActResult.Failure.init))
  }

  private func publishCurrent(
    of state: AppSessionState, in session: HelperSession, connectionID: Int
  ) async throws {
    guard let target = await state.currentCaptureTarget() else {
      try Self.validateObservationCommit(
        current: registry.sessions[session.sessionId], expected: session, app: state,
        connectionID: connectionID)
      captureTargets.remove(session.sessionId, appKey: state.key)
      return
    }
    try Self.validateObservationCommit(
      current: registry.sessions[session.sessionId], expected: session, app: state,
      connectionID: connectionID)
    if video.binding(for: target) == nil, let binding = try? await state.currentVideoBinding() {
      try Self.validateObservationCommit(
        current: registry.sessions[session.sessionId], expected: session, app: state,
        connectionID: connectionID)
      _ = video.register(binding)
    }
    session.processIdentifiers[state.key] = target.process.processIdentifier
    captureTargets.publish(target, for: session.sessionId)
    overlay?.bound(state, windowID: target.windowID)
  }

  /// The main actor's half of committing an observation: the session that
  /// asked must still be the one holding the app.
  private func commit(
    _ observation: Observation,
    of state: AppSessionState,
    in session: HelperSession,
    connectionID: Int
  ) async throws {
    let processIdentifier = await state.processIdentifier
    let windowID = await state.latestWindowID
    let target = await state.committedCaptureTarget(for: observation.observationId)
    try Self.validateObservationCommit(
      current: registry.sessions[session.sessionId],
      expected: session,
      app: state,
      connectionID: connectionID
    )
    if let processIdentifier { session.processIdentifiers[state.key] = processIdentifier }
    if let target {
      if video.binding(for: target) == nil,
        let binding = try? await state.currentVideoBinding()
      {
        try Self.validateObservationCommit(
          current: registry.sessions[session.sessionId], expected: session,
          app: state, connectionID: connectionID)
        _ = video.register(binding)
      }
      captureTargets.publish(target, for: session.sessionId)
    } else {
      // An observation with no verifiable process must supersede the prior window.
      captureTargets.remove(session.sessionId, appKey: state.key)
    }
    overlay?.captured(observation, in: state, keyWindow: windowID)
  }

  /// The commit gate after an asynchronous observation. Object identity is
  /// deliberate: a replacement may reuse the same session id, app and PID.
  static func validateObservationCommit(
    current: HelperSession?,
    expected: HelperSession,
    app: AppSessionState,
    connectionID: Int
  ) throws {
    try expected.cancellation.check()
    guard current === expected,
      expected.connectionID == connectionID,
      expected.app(app.identity.bundleId) === app
    else {
      throw HelperError(.noSession, "That session closed while the app was being observed.")
    }
  }

  private func resolveVideo(_ source: MacVideoSource, connection: IPCConnection) throws
    -> MacVideoResolved
  {
    if source.kind == "task-session", let sessionId = source.sessionId, let appKey = source.appKey,
      appKey == appKey.lowercased(), let session = registry.sessions[sessionId],
      session.connectionID == connection.id, session.cancellation.reason == nil,
      session.app(appKey) != nil,
      let target = captureTargets.current(for: sessionId, appKey: appKey),
      let binding = video.binding(for: target)
    {
      let targets = captureTargets
      let cancellation = session.cancellation
      return MacVideoResolved(
        binding: binding,
        allowed: {
          guard !connection.closedFlag, cancellation.reason == nil,
            let current = targets.current(for: sessionId, appKey: appKey)
          else { return false }
          return binding.matches(current)
        })
    }
    if source.kind == "owner-view", let viewId = source.viewId, let generation = source.generation {
      let view = try ownerViews.require(viewId, generation: generation, connectionID: connection.id)
      let target = view.target
      let resolved = target.flatMap { video.binding(for: $0) }
      guard target != nil, let binding = resolved,
        binding.unavailable == nil
      else {
        let reason = resolved?.unavailable ?? "missing-binding"
        let processCurrent = target?.process.isCurrent ?? false
        Log.observe.error(
          "Owner video binding unavailable: view=\(viewId, privacy: .public) generation=\(generation, privacy: .public) reason=\(reason, privacy: .public) processCurrent=\(processCurrent, privacy: .public)"
        )
        view.videoLease.close()
        throw HelperError(.noSession, "That owner window has ended. Open its view again.")
      }
      let lease = view.videoLease
      return MacVideoResolved(
        binding: binding, allowed: { !connection.closedFlag && lease.allowed })
    }
    throw HelperError(.noSession, "That source has no live exact window binding.")
  }

  // MARK: - Independent person input

  private func mutations(for key: String) -> AppMutationCoordinator {
    if let fence = appMutations[key] { return fence }
    let fence = AppMutationCoordinator()
    appMutations[key] = fence
    return fence
  }

  private func attachmentKey(streamID: String, source: MacVideoSource) -> String {
    "\(streamID):\(source.viewId ?? ""):l\(source.generation ?? 0)"
  }

  func installOwnerAttachment(streamID: String, source: MacVideoSource, connection: IPCConnection,
    binding: MacVideoBinding, producer: any MacVideoProducing, path: String,
    verification: (@Sendable () async throws -> String)? = nil) -> MacOwnerAttachment? {
    let id = attachmentKey(streamID: streamID, source: source)
    guard ownerAttachments[id] == nil else { return nil }
    let attachment = MacOwnerAttachment(id: id, streamID: streamID, source: source,
      connection: connection, binding: binding, producer: producer,
      mutations: mutations(for: binding.target.app.bundleId.lowercased()), path: path, verification: verification)
    ownerAttachments[id] = attachment
    updateOverlay()
    return attachment
  }

  private func resetOwnerInput(_ envelope: RequestEnvelope, connection: IPCConnection) async throws -> Wire.EmptyResult {
    let params = try envelope.decodeParams(MacOwnerInput.ResetParams.self, method: envelope.method)
    let id = attachmentKey(streamID: params.streamId, source: params.source)
    if let attachment = ownerAttachments[id], attachment.connection === connection {
      releaseOwnerInput(attachment, reason: "reset")
      await waitForOwnerCleanup(attachment)
    }
    return Wire.EmptyResult()
  }

  private func waitForOwnerCleanup(_ attachment: MacOwnerAttachment) async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      attachment.queue.enqueue { continuation.resume() }
    }
  }

  private func ownerInput(_ envelope: RequestEnvelope, connection: IPCConnection, budget: WorkBudget)
    async throws -> MacOwnerInput.Result {
    let params = try envelope.decodeParams(MacOwnerInput.InputParams.self, method: envelope.method)
    guard params.sequence >= 0, params.sequence <= 9_007_199_254_740_991,
      params.geometry > 0, params.geometry <= 9_007_199_254_740_991 else {
      throw HelperError(.failed, "Owner input needs a valid generation and sequence.")
    }
    guard connection.negotiatedOwnerInputVersion == 2, params.source.kind == "owner-view"
    else { return MacOwnerInput.Result(sequence: params.sequence, outcome: "refused", reason: "unavailable") }
    tickOwnerInput()
    let id = attachmentKey(streamID: params.streamId, source: params.source)
    if let previous = ownerAttachments[id], !previous.active.current {
      await waitForOwnerCleanup(previous)
    }
    do {
      try budget.check()
      try Self.requireUnlocked()
      guard (1...64).contains(params.events.count) else { throw MacOwnerInput.Refusal("unsupported") }
      for event in params.events { try event.validate() }
      let (binding, producer) = try video.ownerInputTarget(streamID: params.streamId, source: params.source, connection: connection)
      guard params.geometry == producer.inputMap?.generation else { throw MacOwnerInput.Refusal("stale") }
      if ownerAttachments[id] == nil {
        let catalog = catalog, identity = binding.target.app
        _ = installOwnerAttachment(streamID: params.streamId, source: params.source, connection: connection,
          binding: binding, producer: producer,
          path: NSRunningApplication(processIdentifier: binding.target.process.processIdentifier)?.bundleURL?.path ?? "",
          verification: { try await catalog.verifiedRecord(for: identity).path })
      }
      guard let lease = ownerAttachments[id], lease.connection === connection, lease.active.current
      else { throw MacOwnerInput.Refusal("unavailable") }
      let bytes = try JSONCoding.encoder.encode(envelope.params).count
      let reservation = try lease.admission.admit(sequence: params.sequence, bytes: bytes)
      let deadline = ProcessInfo.processInfo.systemUptime + budget.remaining()
      return await withCheckedContinuation { continuation in
        if lease.mailbox.append(.init(params: params, reservation: reservation, deadline: deadline, reply: continuation)) {
          lease.queue.enqueue { await lease.worker.drain(lease) }
        }
      }
    } catch let refusal as MacOwnerInput.Refusal {
      return MacOwnerInput.Result(sequence: params.sequence,
        outcome: refusal.reason == "stale" ? "stale" : "refused", reason: refusal.reason)
    } catch {
      return MacOwnerInput.Result(sequence: params.sequence, outcome: "refused", reason: "unavailable")
    }
  }

  private func releaseOwnerInput(_ lease: MacOwnerAttachment, reason: String) {
    guard lease.active.withLock({ value in let old = value; value = false; return old }) else { return }
    lease.admission.invalidate()
    lease.queue.enqueue { [self] in
      await lease.mutations.beginPerson()
      await lease.worker.cleanup(lease)
      lease.focus.stop()
      lease.mutations.endPerson()
      await finishOwnerRelease(lease, reason: reason)
    }
  }
  private func finishOwnerRelease(_ lease: MacOwnerAttachment, reason: String) {
    if ownerAttachments[lease.id] === lease { ownerAttachments[lease.id] = nil }
    let counts = lease.counters.current.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: ",")
    Log.session.notice("Owner input released: reason=\(reason, privacy: .public) counters=\(counts, privacy: .public)")
    updateOverlay()
  }
  private func releaseAllOwnerInput(reason: String) {
    for lease in ownerAttachments.values { releaseOwnerInput(lease, reason: reason) }
  }
  private func tickOwnerInput() {
    let now = ProcessInfo.processInfo.systemUptime
    for lease in ownerAttachments.values where lease.active.current {
      let source = try? video.ownerInputTarget(streamID: lease.streamID, source: lease.source, connection: lease.connection)
      let reason: String?
      if (try? Self.requireUnlocked()) == nil { reason = "secure-lock" }
      else if !AXIsProcessTrusted() || lease.guardFailed.current || source == nil || !lease.producer.inputVisible || !lease.binding.target.process.isCurrent || lease.binding.unavailable != nil { reason = "stream-lost" }
      else if lease.producer.inputMap?.generation != lease.generation { reason = "stream-lost" }
      else if lease.heldDeadline.current.map({ now >= $0 }) == true { reason = "timed-out" }
      else { reason = nil }
      if let reason { releaseOwnerInput(lease, reason: reason) }
      else if lease.admission.pendingBatches == 0, !lease.burstActive.current,
        let map = lease.producer.inputMap,
        lease.contextPending.withLock({ value in if value { return false }; value = true; return true }) {
        Task {
          await lease.worker.publishContext(lease, map: map)
          lease.contextPending.withLock { $0 = false }
        }
      }
    }
  }

  // MARK: - Connections and clocks

  func connectionClosed(_ connection: IPCConnection) {
    for lease in ownerAttachments.values where lease.connection === connection { releaseOwnerInput(lease, reason: "viewer-gone") }
    video.disconnected(connection)
    closedConnectionIDs.insert(connection.id)
    connections[connection.id] = nil
    ownerViews.remove(connectionID: connection.id)
    for session in Array(registry.sessions.values) where session.connectionID == connection.id {
      closeSession(session.sessionId, reason: nil, overlayEnding: nil)
    }
    updateOverlay(ending: .connectionLost)
    if connections.isEmpty, registry.sessions.isEmpty { idleSince = Date() }
  }

  private func tick() {
    refreshPermissions(deferRestart: false)
    ownerViews.prune()
    expireIdleSession()
    noticeQuitApps()
    pruneStoppedSessions()

    // A pending restart does not wait for the connections to go away.
    restartIfGrantPending()

    if registry.sessions.isEmpty, connections.isEmpty {
      let since = idleSince ?? Date()
      idleSince = since
      if Date().timeIntervalSince(since) >= Self.processIdleTimeout {
        Log.lifecycle.notice("Quitting after fifteen idle minutes.")
        NSApplication.shared.terminate(nil)
      }
    } else {
      idleSince = nil
    }
  }

  func expireIdleSession() {
    for session in Array(registry.sessions.values)
    where Date().timeIntervalSince(session.lastUsedAt) >= Self.sessionIdleTimeout {
      closeSession(session.sessionId, reason: nil)
    }
  }

  /// A session whose one app has quit ends with `app-quit`. The check reads
  /// the running-application list, never a signature or the app itself, so
  /// it costs the main actor nothing.
  func noticeQuitApps() {
    for session in Array(registry.sessions.values) {
      let states = session.orderedApps
      guard states.count == 1, let only = states.first,
        session.processIdentifiers[only.key] != nil
      else { continue }
      guard !appRunning(only.identity.bundleId, only.path)
      else { continue }
      closeSession(session.sessionId, reason: .appQuit)
    }
  }

  private func pruneStoppedSessions() {
    let cutoff = Date().addingTimeInterval(-3_600)
    stoppedSessions = stoppedSessions.filter { $0.value > cutoff }
  }
}
