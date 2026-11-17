// A narrow port of T3 Code's T3ComposerEditorView.swift
// (https://github.com/pingdotgg/t3code), Copyright (c) 2026 T3 Tools Inc., MIT License:
// a UITextView whose Markdown references are atomic NSTextAttachment chips.
import ExpoModulesCore
import UIKit

struct ComposerTokenPayload: Decodable, Equatable {
  var start: Int
  var end: Int
  let source: String
  let label: String
  let symbol: String
  let accessibilityLabel: String

  func rendersLike(_ other: Self) -> Bool {
    label == other.label && symbol == other.symbol && accessibilityLabel == other.accessibilityLabel &&
      source.utf16.elementsEqual(other.source.utf16)
  }
}

struct ComposerSelectionPayload: Decodable, Equatable {
  let start: Int
  let end: Int
}

private struct ComposerDocumentPayload: Decodable {
  let value: String
  let selection: ComposerSelectionPayload?
  let tokens: [ComposerTokenPayload]
  let eventCount: Int
  let isNativeEcho: Bool
  let generation: Int
}

struct ComposerThemePayload: Decodable {
  let text: String
  let placeholder: String
  let tint: String
  let chipText: String
  let chipGlyph: String
  let chipFill: String
  let chipRim: String
  let chipEdge: String
  let chipSelectedRim: String
}

private final class ComposerChip: NSTextAttachment {
  let token: ComposerTokenPayload

  init(token: ComposerTokenPayload, image: UIImage, bounds: CGRect) {
    self.token = token
    super.init(data: nil, ofType: nil)
    self.image = image
    self.bounds = bounds
  }

  required init?(coder: NSCoder) { nil }
}

private final class ComposerChipAccessibilityElement: UIAccessibilityElement {
  var activate: (() -> Bool)?
  override func accessibilityActivate() -> Bool { activate?() ?? false }
}

private final class ComposerTextView: UITextView {
  var onPasteImages: (([NSItemProvider]) -> Void)?
  var onEmptyBackspace: (() -> Void)?
  var sourceForRange: ((NSRange) -> String)?

  private var pastesImages: Bool {
    let board = UIPasteboard.general
    // Text keeps priority, as it did in the plain field: images only when the paste has no words.
    return !board.hasStrings && !PastedImages.providers(board.itemProviders).isEmpty
  }

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(paste(_:)), isEditable, pastesImages { return true }
    return super.canPerformAction(action, withSender: sender)
  }

  override func canPaste(_ itemProviders: [NSItemProvider]) -> Bool {
    guard isEditable else { return false }
    // UIKit checks canPaste before forwarding a drag to UITextDropDelegate.
    if !itemProviders.isEmpty, PastedImages.providers(itemProviders).count == itemProviders.count {
      return true
    }
    return super.canPaste(itemProviders)
  }

  override func paste(itemProviders: [NSItemProvider]) {
    guard isEditable else { return }
    let images = PastedImages.providers(itemProviders)
    if !images.isEmpty, images.count == itemProviders.count {
      onPasteImages?(images)
      return
    }
    super.paste(itemProviders: itemProviders)
  }

  override func paste(_ sender: Any?) {
    guard isEditable else { return }
    if pastesImages {
      onPasteImages?(PastedImages.providers(UIPasteboard.general.itemProviders))
      return
    }
    super.paste(sender)
  }

  override func copy(_ sender: Any?) {
    guard selectedRange.length > 0, let source = sourceForRange?(selectedRange) else {
      return super.copy(sender)
    }
    // A chip copies as its whole Markdown link, so a paste brings the reference back.
    UIPasteboard.general.string = source
  }

  override func cut(_ sender: Any?) {
    guard isEditable, selectedRange.length > 0, let range = selectedTextRange else {
      return super.cut(sender)
    }
    copy(sender)
    replace(range, withText: "")
  }

  override func deleteBackward() {
    if textStorage.length == 0 { onEmptyBackspace?() }
    guard selectedRange.length == 0, selectedRange.location > 0 else {
      super.deleteBackward()
      return
    }
    let previous = selectedRange.location - 1
    if textStorage.attribute(.attachment, at: previous, effectiveRange: nil) is ComposerChip,
       let start = position(from: beginningOfDocument, offset: previous),
       let end = position(from: start, offset: 1),
       let range = textRange(from: start, to: end) {
      replace(range, withText: "")
      return
    }
    super.deleteBackward()
  }
}

public final class ComposerEditorView: ExpoView, UITextViewDelegate, UITextDropDelegate, UIGestureRecognizerDelegate {
  // This view reads `layoutManager`, which would otherwise swap a live TextKit 2 view to
  // TextKit 1 mid-edit; that swap can leave typed text laid out but never drawn.
  private let textView = ComposerTextView(usingTextLayoutManager: false)
  private let placeholderLabel = UILabel()
  private var value = ""
  private var tokens: [ComposerTokenPayload] = []
  private var requestedSelection: ComposerSelectionPayload?
  private var theme: ComposerThemePayload?
  private var fontSize: CGFloat = 17
  private var lineHeight: CGFloat = 22
  private var paddingVertical: CGFloat = 0
  private var shouldAutoFocus = false
  private var didAutoFocus = false
  private var isApplyingControlledValue = false
  private var nativeEventCount = 0
  private var generation = 0
  private var hasControlledDocument = false
  private var tokensNeedRebuild = false
  private var hasDeferredForcedRebuild = false
  private var chipsNeedMeasuredWidth = false
  private var selectedChipRanges: [NSRange] = []
  private var lastContentHeight: CGFloat = 0
  var maxBytes = 0

  let onComposerChange = EventDispatcher()
  let onComposerSelectionChange = EventDispatcher()
  let onComposerFocus = EventDispatcher()
  let onComposerBlur = EventDispatcher()
  let onComposerPasteImages = EventDispatcher()
  let onComposerContentSizeChange = EventDispatcher()
  let onComposerEmptyBackspace = EventDispatcher()

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    textView.delegate = self
    textView.textDropDelegate = self
    textView.backgroundColor = .clear
    textView.textContainerInset = .zero
    textView.textContainer.lineFragmentPadding = 0
    textView.keyboardDismissMode = .interactive
    textView.alwaysBounceVertical = false
    textView.keyboardAppearance = .dark
    if #available(iOS 26.0, *) {
      // UIKit can attach a nearby bar's scroll edge effect to this text view; its backdrop
      // then draws over the typed text while the caret stays visible.
      for edge in [textView.topEdgeEffect, textView.leftEdgeEffect, textView.bottomEdgeEffect, textView.rightEdgeEffect] {
        edge.isHidden = true
      }
    }
    textView.sourceForRange = { [weak self] range in
      guard let self else { return "" }
      return ComposerDocument.source(segments: self.displayedSegments(), displayRange: range)
    }
    textView.onPasteImages = { [weak self] providers in self?.pasteImages(providers) }
    textView.onEmptyBackspace = { [weak self] in self?.onComposerEmptyBackspace() }
    let chipTap = UITapGestureRecognizer(target: self, action: #selector(selectTappedChip(_:)))
    chipTap.cancelsTouchesInView = false
    chipTap.delegate = self
    textView.addGestureRecognizer(chipTap)
    addSubview(textView)
    placeholderLabel.numberOfLines = 1
    placeholderLabel.isAccessibilityElement = false
    addSubview(placeholderLabel)
    applyTypography()
  }

  // MARK: Props

  func setDocumentJson(_ json: String) {
    guard let document = decode(ComposerDocumentPayload.self, from: json) else { return }
    // A parent reset (a send clearing the field) wins over native edits it could not see;
    // JS drops their events by generation, so the count restarts where JS last acknowledged.
    let isReset = document.generation > generation
    guard isReset || document.eventCount >= nativeEventCount else { return }
    if isReset {
      generation = document.generation
      endComposition()
    }
    // A remounted view continues from JS's revision, or JS would drop every event it sends.
    nativeEventCount = document.eventCount
    if document.isNativeEcho, !isReset, hasControlledDocument, serializedText() != document.value {
      return
    }
    hasControlledDocument = true
    // Typing before a chip only moves its offsets; rebuilding then makes iOS autocorrect behind the caret.
    if !document.tokens.elementsEqual(tokens, by: { $0.rendersLike($1) }) {
      tokensNeedRebuild = true
    }
    tokens = document.tokens
    value = document.value
    requestedSelection = document.selection
    applyControlledDocument(force: tokensNeedRebuild)
    applyRequestedSelection()
    if ComposerDocument.validAtoms(atoms(), in: value).count == tokens.count {
      tokensNeedRebuild = false
    }
  }

  func setThemeJson(_ json: String) {
    guard let next = decode(ComposerThemePayload.self, from: json) else { return }
    theme = next
    textView.textColor = UIColor(composerHex: next.text) ?? .label
    textView.tintColor = UIColor(composerHex: next.tint)
    placeholderLabel.textColor = UIColor(composerHex: next.placeholder) ?? .placeholderText
    applyControlledDocument(force: true)
  }

  func setPlaceholder(_ placeholder: String) {
    placeholderLabel.text = placeholder
    setNeedsLayout()
  }

  func setLabel(_ label: String) {
    textView.accessibilityLabel = label
  }

  func setTypography(fontSize: CGFloat, lineHeight: CGFloat, paddingVertical: CGFloat) {
    guard fontSize != self.fontSize || lineHeight != self.lineHeight || paddingVertical != self.paddingVertical else {
      return
    }
    self.fontSize = fontSize
    self.lineHeight = lineHeight
    self.paddingVertical = paddingVertical
    textView.textContainerInset = UIEdgeInsets(top: paddingVertical, left: 0, bottom: paddingVertical, right: 0)
    applyTypography()
    applyControlledDocument(force: true)
  }

  func setEditable(_ editable: Bool) {
    textView.isEditable = editable
    textView.isSelectable = editable
  }

  func setAutoFocus(_ autoFocus: Bool) {
    shouldAutoFocus = autoFocus
  }

  // MARK: Commands

  func focusEditor() {
    textView.becomeFirstResponder()
  }

  func blurEditor() {
    textView.resignFirstResponder()
  }

  func setSelection(start: Int, end: Int) {
    requestedSelection = ComposerSelectionPayload(start: start, end: end)
    applyRequestedSelection()
  }

  func readState() -> [String: Any] {
    statePayload(value: serializedText())
  }

  // MARK: Layout

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window != nil, shouldAutoFocus, !didAutoFocus else { return }
    didAutoFocus = true
    DispatchQueue.main.async { [weak self] in self?.textView.becomeFirstResponder() }
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    textView.frame = bounds
    if chipsNeedMeasuredWidth, bounds.width > 0 {
      chipsNeedMeasuredWidth = false
      applyControlledDocument(force: true)
    }
    placeholderLabel.frame = CGRect(
      x: 0,
      y: paddingVertical,
      width: bounds.width,
      height: max(lineHeight, placeholderLabel.font.lineHeight)
    )
    emitContentSizeIfNeeded()
  }

  public override var accessibilityElements: [Any]? {
    get {
      var elements: [Any] = [textView]
      let layout = textView.layoutManager
      let storage = textView.textStorage
      storage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
        guard let chip = value as? ComposerChip else { return }
        let glyphs = layout.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        let rect = layout.boundingRect(forGlyphRange: glyphs, in: textView.textContainer)
          .offsetBy(dx: textView.textContainerInset.left, dy: textView.textContainerInset.top)
        guard rect.intersects(textView.bounds) else { return }
        let element = ComposerChipAccessibilityElement(accessibilityContainer: self)
        element.accessibilityLabel = chip.token.accessibilityLabel
        element.accessibilityHint = "Selects this reference"
        element.accessibilityTraits = .button
        element.accessibilityFrameInContainerSpace = textView.convert(rect, to: self)
        element.activate = { [weak self] in
          guard let self, range.location < self.textView.textStorage.length,
                self.textView.textStorage.attribute(.attachment, at: range.location, effectiveRange: nil) as? ComposerChip === chip
          else { return false }
          self.textView.becomeFirstResponder()
          self.textView.selectedRange = range
          return true
        }
        elements.append(element)
      }
      return elements
    }
    set { super.accessibilityElements = newValue }
  }

  // MARK: Chip selection

  @objc private func selectTappedChip(_ recognizer: UITapGestureRecognizer) {
    let point = recognizer.location(in: textView)
    let container = CGPoint(x: point.x - textView.textContainerInset.left, y: point.y - textView.textContainerInset.top)
    let layout = textView.layoutManager
    let index = layout.characterIndex(for: container, in: textView.textContainer, fractionOfDistanceBetweenInsertionPoints: nil)
    guard textView.isEditable, index < textView.textStorage.length,
          textView.textStorage.attribute(.attachment, at: index, effectiveRange: nil) is ComposerChip else { return }
    let glyphs = layout.glyphRange(forCharacterRange: NSRange(location: index, length: 1), actualCharacterRange: nil)
    guard layout.boundingRect(forGlyphRange: glyphs, in: textView.textContainer).contains(container) else { return }
    textView.becomeFirstResponder()
    // UIKit places the caret from its own tap recognizer during this same touch.
    DispatchQueue.main.async { [weak self] in
      self?.textView.selectedRange = NSRange(location: index, length: 1)
    }
  }

  public func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool { true }

  public func textView(
    _ textView: UITextView,
    shouldInteractWith textAttachment: NSTextAttachment,
    in characterRange: NSRange,
    interaction: UITextItemInteraction
  ) -> Bool {
    // A chip is a reference, not an image to save to the camera roll.
    !(textAttachment is ComposerChip)
  }

  /// A selected chip takes the accent rim; redrawing only its image leaves typing undisturbed.
  private func updateSelectedChips() {
    let selection = textView.selectedRange
    var next: [NSRange] = []
    if selection.length > 0 {
      textView.textStorage.enumerateAttribute(.attachment, in: selection) { value, range, _ in
        if value is ComposerChip { next.append(range) }
      }
    }
    guard next != selectedChipRanges else { return }
    let changed = selectedChipRanges + next
    selectedChipRanges = next
    for range in changed where NSMaxRange(range) <= textView.textStorage.length {
      guard let chip = textView.textStorage.attribute(.attachment, at: range.location, effectiveRange: nil) as? ComposerChip
      else { continue }
      chip.image = renderChip(chip.token, selected: next.contains(range)).image
      textView.layoutManager.invalidateDisplay(forCharacterRange: range)
    }
  }

  // MARK: UITextViewDelegate

  public func textViewDidChange(_ textView: UITextView) {
    emitTextChange()
  }

  public func textViewDidChangeSelection(_ textView: UITextView) {
    guard !isApplyingControlledValue else { return }
    restoreBaseTypingAttributes()
    updateSelectedChips()
    // UIKit moves the selection before textViewDidChange runs. Emitting here would pair
    // the post-edit text with a pre-edit count, so the change event carries both.
    guard serializedText() == value else { return }
    emitEvent(onComposerSelectionChange, value: value)
  }

  public func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
    restoreBaseTypingAttributes()
    return true
  }

  public func textViewDidBeginEditing(_ textView: UITextView) {
    onComposerFocus()
  }

  public func textViewDidEndEditing(_ textView: UITextView) {
    onComposerBlur()
  }

  // MARK: Drops

  public func textDroppableView(
    _ textDroppableView: UIView & UITextDroppable,
    proposalForDrop drop: UITextDropRequest
  ) -> UITextDropProposal {
    guard droppedImages(drop) != nil else { return drop.suggestedProposal }
    // The editor owns image drops, so UIKit never inserts an attachment the Markdown cannot hold.
    let proposal = UITextDropProposal(operation: .copy)
    proposal.dropAction = .insert
    proposal.dropPerformer = .delegate
    return proposal
  }

  public func textDroppableView(_ textDroppableView: UIView & UITextDroppable, willPerformDrop drop: UITextDropRequest) {
    if let providers = droppedImages(drop) { pasteImages(providers) }
  }

  private func droppedImages(_ drop: UITextDropRequest) -> [NSItemProvider]? {
    let providers = drop.dropSession.items.map(\.itemProvider)
    let images = PastedImages.providers(providers)
    return !images.isEmpty && images.count == providers.count ? images : nil
  }

  private func pasteImages(_ providers: [NSItemProvider]) {
    PastedImages.load(
      providers,
      maxBytes: maxBytes,
      isLive: { [weak self] in self?.window != nil },
      deliver: { [weak self] payload in self?.onComposerPasteImages(payload) }
    )
  }

  // MARK: Document

  private func atoms() -> [ComposerAtom] {
    tokens.map { ComposerAtom(start: $0.start, end: $0.end, source: $0.source) }
  }

  /// What the text view shows now, which can run ahead of `value` while the person types.
  private func displayedSegments() -> [ComposerSegment] {
    let storage = textView.textStorage
    let text = storage.string as NSString
    var segments: [ComposerSegment] = []
    storage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
      if let chip = value as? ComposerChip {
        segments.append(.atom(chip.token.source))
      } else {
        segments.append(.text(text.substring(with: range)))
      }
    }
    return segments
  }

  private func serializedText() -> String {
    ComposerDocument.source(
      segments: displayedSegments(),
      displayRange: NSRange(location: 0, length: textView.textStorage.length)
    )
  }

  private func sourceSelection() -> ComposerSelectionPayload {
    let segments = displayedSegments()
    let range = textView.selectedRange
    return ComposerSelectionPayload(
      start: ComposerDocument.sourceOffset(displayOffset: range.location, segments: segments),
      end: ComposerDocument.sourceOffset(displayOffset: NSMaxRange(range), segments: segments)
    )
  }

  private func displayRange(for selection: ComposerSelectionPayload) -> NSRange {
    let segments = ComposerDocument.segments(source: value, atoms: atoms())
    let start = ComposerDocument.displayOffset(sourceOffset: selection.start, segments: segments)
    let end = ComposerDocument.displayOffset(sourceOffset: selection.end, segments: segments)
    return NSRange(location: start, length: max(0, end - start))
  }

  private func applyControlledDocument(force: Bool = false) {
    // Rebuilding the attributed string tears down an active IME composition. Committing
    // the composition sends a new value from JS, and that update rebuilds.
    if textView.markedTextRange != nil {
      hasDeferredForcedRebuild = hasDeferredForcedRebuild || force
      updatePlaceholder()
      return
    }
    let shouldForce = force || hasDeferredForcedRebuild
    guard shouldForce || serializedText() != value || !displayMatchesTokens() else {
      updatePlaceholder()
      return
    }
    hasDeferredForcedRebuild = false
    let previousSelection = sourceSelection()
    isApplyingControlledValue = true
    textView.attributedText = makeAttributedDocument()
    let target = requestedSelection ?? previousSelection
    requestedSelection = nil
    textView.selectedRange = displayRange(for: target)
    selectedChipRanges = []
    restoreBaseTypingAttributes()
    isApplyingControlledValue = false
    updateSelectedChips()
    updatePlaceholder()
    setNeedsLayout()
  }

  private func applyRequestedSelection() {
    guard let requested = requestedSelection else { return }
    let next = displayRange(for: requested)
    guard NSMaxRange(next) <= textView.attributedText.length else { return }
    requestedSelection = nil
    // Assigning selectedRange resets the keyboard's autocorrect context even when unchanged.
    guard !NSEqualRanges(next, textView.selectedRange) else { return }
    isApplyingControlledValue = true
    textView.selectedRange = next
    isApplyingControlledValue = false
    updateSelectedChips()
  }

  private func endComposition() {
    guard textView.markedTextRange != nil else { return }
    isApplyingControlledValue = true
    textView.unmarkText()
    isApplyingControlledValue = false
  }

  private func displayMatchesTokens() -> Bool {
    let expected = ComposerDocument.segments(source: value, atoms: atoms())
    return displayedSegments().filter { if case .atom = $0 { return true }; return false } ==
      expected.filter { if case .atom = $0 { return true }; return false }
  }

  private func makeAttributedDocument() -> NSAttributedString {
    let result = NSMutableAttributedString()
    let valid = ComposerDocument.validAtoms(atoms(), in: value)
    let source = value as NSString
    var cursor = 0
    for atom in valid {
      guard let token = tokens.first(where: { $0.start == atom.start && $0.end == atom.end }) else { continue }
      if atom.start > cursor {
        result.append(NSAttributedString(
          string: source.substring(with: NSRange(location: cursor, length: atom.start - cursor)),
          attributes: baseAttributes()
        ))
      }
      let chip = renderChip(token, selected: false)
      let attachment = NSMutableAttributedString(attachment: ComposerChip(token: token, image: chip.image, bounds: chip.bounds))
      attachment.addAttributes(baseAttributes(), range: NSRange(location: 0, length: attachment.length))
      result.append(attachment)
      cursor = atom.end
    }
    if cursor < source.length {
      result.append(NSAttributedString(string: source.substring(from: cursor), attributes: baseAttributes()))
    }
    return result
  }

  /// The transcript's surface chip at text size: plate fill, rim, glyph, one line of title.
  private func renderChip(_ token: ComposerTokenPayload, selected: Bool) -> (image: UIImage, bounds: CGRect) {
    let base = font()
    let labelFont = UIFont.systemFont(ofSize: fontSize * 0.92)
    let height = min(ceil(labelFont.pointSize * 1.45), lineHeight)
    let glyphSide = labelFont.pointSize
    let left = labelFont.pointSize * 0.32
    let gap = labelFont.pointSize * 0.3
    let right = labelFont.pointSize * 0.5
    let available = textView.textContainer.size.width > 0 && textView.textContainer.size.width < 10_000
      ? textView.textContainer.size.width
      : (window?.bounds.width ?? bounds.width)
    if available <= 0 { chipsNeedMeasuredWidth = true }
    let maximum = min(labelFont.pointSize * 24, max(labelFont.pointSize * 4, available - 2))
    let color = { (hex: String?) in UIColor(composerHex: hex) }
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineBreakMode = .byTruncatingTail
    let label = NSAttributedString(string: token.label, attributes: [
      .font: labelFont,
      .foregroundColor: color(theme?.chipText) ?? .label,
      .paragraphStyle: paragraph,
    ])
    let labelWidth = min(ceil(label.size().width), maximum - left - glyphSide - gap - right)
    let width = ceil(left + glyphSide + gap + labelWidth + right)
    let format = UIGraphicsImageRendererFormat.preferred()
    format.opaque = false
    let image = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format).image { context in
      let rect = CGRect(x: 0.5, y: 0.5, width: width - 1, height: height - 1)
      let plate = UIBezierPath(roundedRect: rect, cornerRadius: rect.height / 2)
      (color(theme?.chipFill) ?? .secondarySystemBackground).setFill()
      plate.fill()
      // The plate's top light, as the transcript chip draws it.
      context.cgContext.saveGState()
      plate.addClip()
      (color(theme?.chipEdge) ?? .clear).setFill()
      UIRectFill(CGRect(x: 0, y: 0, width: width, height: 1))
      context.cgContext.restoreGState()
      (color(selected ? theme?.chipSelectedRim : theme?.chipRim) ?? .separator).setStroke()
      plate.lineWidth = selected ? 1.5 : 1
      plate.stroke()
      let configuration = UIImage.SymbolConfiguration(pointSize: glyphSide * 0.82, weight: .regular)
      if let glyph = UIImage(systemName: token.symbol, withConfiguration: configuration)?
        .withTintColor(color(theme?.chipGlyph) ?? .secondaryLabel, renderingMode: .alwaysOriginal) {
        let size = glyph.size
        glyph.draw(in: CGRect(
          x: left + (glyphSide - size.width) / 2,
          y: (height - size.height) / 2,
          width: size.width,
          height: size.height
        ))
      }
      let textHeight = ceil(labelFont.lineHeight)
      label.draw(in: CGRect(x: left + glyphSide + gap, y: (height - textHeight) / 2, width: labelWidth, height: textHeight))
    }
    // Centred on the line's text, so the chip sits on the baseline without growing the line.
    let y = (base.ascender + base.descender - height) / 2
    return (image, CGRect(x: 0, y: y, width: width, height: height))
  }

  private func font() -> UIFont {
    UIFont.systemFont(ofSize: fontSize)
  }

  private func baseAttributes() -> [NSAttributedString.Key: Any] {
    let paragraph = NSMutableParagraphStyle()
    paragraph.minimumLineHeight = lineHeight
    paragraph.maximumLineHeight = lineHeight
    let font = font()
    return [
      .font: font,
      .foregroundColor: UIColor(composerHex: theme?.text) ?? .label,
      .paragraphStyle: paragraph,
      // Centre the glyphs in the fixed line, as RN's Text does and a raw paragraph does not.
      .baselineOffset: (lineHeight - font.lineHeight) / 4,
    ]
  }

  private func applyTypography() {
    textView.font = font()
    placeholderLabel.font = font()
    restoreBaseTypingAttributes()
    setNeedsLayout()
  }

  private func restoreBaseTypingAttributes() {
    guard textView.markedTextRange == nil else { return }
    textView.typingAttributes = baseAttributes()
  }

  private func updatePlaceholder() {
    placeholderLabel.isHidden = textView.textStorage.length > 0
  }

  // MARK: Events

  private func statePayload(value: String) -> [String: Any] {
    let selection = sourceSelection()
    return [
      "value": value,
      "selection": ["start": selection.start, "end": selection.end],
      "eventCount": nativeEventCount,
      "generation": generation,
      "composing": textView.markedTextRange != nil,
    ]
  }

  private func emitTextChange() {
    guard !isApplyingControlledValue else { return }
    value = serializedText()
    emitEvent(onComposerChange, value: value)
    updatePlaceholder()
    emitContentSizeIfNeeded()
  }

  /// Caret moves advance the count like edits: a payload computed before one is stale.
  private func emitEvent(_ dispatch: EventDispatcher, value: String) {
    nativeEventCount += 1
    dispatch(statePayload(value: value))
  }

  private func emitContentSizeIfNeeded() {
    guard bounds.width > 0 else { return }
    let height = ceil(textView.sizeThatFits(CGSize(width: bounds.width, height: .greatestFiniteMagnitude)).height)
    guard abs(height - lastContentHeight) > 0.5 else { return }
    lastContentHeight = height
    onComposerContentSizeChange(["height": height])
  }

  private func decode<T: Decodable>(_ type: T.Type, from json: String) -> T? {
    guard let data = json.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(type, from: data)
  }
}

extension UIColor {
  /// `#rrggbb`, `#rrggbbaa` or `rgba(r, g, b, a)`, as the app's theme writes them.
  convenience init?(composerHex value: String?) {
    guard let value = value?.trimmingCharacters(in: .whitespaces), !value.isEmpty else { return nil }
    if value.hasPrefix("rgba(") {
      let parts = value.dropFirst(5).dropLast().split(separator: ",").compactMap {
        Double($0.trimmingCharacters(in: .whitespaces))
      }
      guard parts.count == 4 else { return nil }
      self.init(red: parts[0] / 255, green: parts[1] / 255, blue: parts[2] / 255, alpha: parts[3])
      return
    }
    var hex = value
    if hex.hasPrefix("#") { hex.removeFirst() }
    guard hex.count == 6 || hex.count == 8, let raw = UInt64(hex, radix: 16) else { return nil }
    if hex.count == 8 {
      self.init(
        red: CGFloat((raw >> 24) & 0xff) / 255,
        green: CGFloat((raw >> 16) & 0xff) / 255,
        blue: CGFloat((raw >> 8) & 0xff) / 255,
        alpha: CGFloat(raw & 0xff) / 255
      )
    } else {
      self.init(
        red: CGFloat((raw >> 16) & 0xff) / 255,
        green: CGFloat((raw >> 8) & 0xff) / 255,
        blue: CGFloat(raw & 0xff) / 255,
        alpha: 1
      )
    }
  }
}
