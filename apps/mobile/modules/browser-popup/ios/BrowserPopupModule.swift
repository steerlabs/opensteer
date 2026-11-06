import ExpoModulesCore
import UIKit

public final class BrowserPopupModule: Module {
  private var fence = PopupFence()
  private var picker: PopupController?
  public func definition() -> ModuleDefinition {
    Name("BrowserPopup")
    Constants(["popupPresentationVersion": 1])
    Events("onAction")
    AsyncFunction("present") { (id: String, revision: String, raw: [String: Any]) -> Bool in self.install(id, revision, raw) }.runOnQueue(.main)
    AsyncFunction("update") { (id: String, revision: String, raw: [String: Any]) -> Bool in
      guard self.fence.id == id else { return false }; return self.install(id, revision, raw)
    }.runOnQueue(.main)
    AsyncFunction("dismiss") { (id: String) in self.dismiss(id) }.runOnQueue(.main)
    OnAppEntersBackground { self.cancelCurrent() }
    OnDestroy { DispatchQueue.main.async { self.cancelCurrent() } }
  }
  private func install(_ id: String, _ revision: String, _ raw: [String: Any]) -> Bool {
    guard id.utf8.count <= 128, revision.count <= 20,
      let data = try? JSONSerialization.data(withJSONObject: raw), data.count <= 524288,
      let model = try? JSONDecoder().decode(PopupModel.self, from: data), model.items.count <= 1024,
      ["select","date","time","datetime-local","month","week","color"].contains(model.kind), let root = picker?.navigationController?.presentingViewController ?? appContext?.utilities?.currentViewController() else { return false }
    let old = picker
    let originalResponder = old?.openingResponder
    if let prior = fence.id { fence.dismiss(prior); old?.releasePayload(); picker = nil }
    fence.present(id, revision)
    let responder = PopupFirstResponder()
    UIApplication.shared.sendAction(#selector(UIResponder.capturePopupResponder(_:)), to: nil, from: responder, for: nil)
    let controller = PopupController(model)
    controller.openingResponder = originalResponder ?? responder.value
    controller.action = { [weak self, weak controller] answer in
      guard let self, self.fence.accept(id, revision), self.picker === controller else { return }
      var event: [String: Any] = ["presentationId": id, "revision": revision, "action": answer == nil ? "cancel" : "commit"]
      if let answer { event["answer"] = answer; controller?.setPending() }
      self.sendEvent("onAction", event)
      if answer == nil { self.dismiss(id) }
    }
    picker = controller
    let nav = UINavigationController(rootViewController: controller)
    nav.modalPresentationStyle = .pageSheet
    nav.presentationController?.delegate = controller
    let show = { [weak self, weak controller] in
      guard let self, self.fence.accept(id, revision), self.picker === controller else { return }
      root.present(nav, animated: true)
      nav.presentationController?.delegate = controller
    }
    if let old, old.navigationController?.presentingViewController != nil { old.navigationController?.dismiss(animated: false, completion: show) } else { show() }
    return true
  }
  private func dismiss(_ id: String) {
    guard fence.id == id else { return }
    fence.dismiss(id)
    let old = picker; picker = nil; old?.releasePayload()
    old?.navigationController?.dismiss(animated: false)
  }
  private func cancelCurrent() {
    guard let id = fence.id, let revision = fence.revision else { return }
    sendEvent("onAction", ["presentationId": id, "revision": revision, "action": "cancel"])
    dismiss(id)
  }
}

private final class PopupController: UIViewController, UITableViewDataSource, UITableViewDelegate, UIAdaptivePresentationControllerDelegate, UIColorPickerViewControllerDelegate, UIPickerViewDataSource, UIPickerViewDelegate {
  override var keyCommands: [UIKeyCommand]? { [UIKeyCommand(input: UIKeyCommand.inputEscape, modifierFlags: [], action: #selector(cancel))] }
  weak var openingResponder: UIResponder?
  private var keyReleases = PopupKeyReleases()
  override func pressesBegan(_ presses:Set<UIPress>,with event:UIPressesEvent?) { for press in presses { if let key=press.key {keyReleases.began(Int(key.keyCode.rawValue))} };super.pressesBegan(presses,with:event) }
  override func pressesEnded(_ presses:Set<UIPress>,with event:UIPressesEvent?) {
    for press in presses {
      if let key=press.key, keyReleases.ended(Int(key.keyCode.rawValue)), let openingResponder {openingResponder.pressesEnded([press],with:event)}
      else {super.pressesEnded([press],with:event)}
    }
  }
  private var model: PopupModel?
  private var selected = Set<String>()
  private var draft: String
  private var pending = false
  private let table = UITableView(frame: .zero, style: .insetGrouped)
  private let exact = UITextField()
  private var componentPicker: UIPickerView?
  var action: (([String: Any]?) -> Void)?
  init(_ model: PopupModel) { self.model = model; draft = model.value ?? ""; selected = Set(model.items.filter { $0.enabled && $0.selected && $0.kind == "option" }.map(\.id)); super.init(nibName: nil, bundle: nil) }
  required init?(coder: NSCoder) { fatalError("Unavailable") }
  override func viewDidLoad() {
    super.viewDidLoad(); guard let model else { return }
    view.backgroundColor = .systemBackground
    view.semanticContentAttribute = model.rtl ? .forceRightToLeft : .forceLeftToRight
    title = model.kind == "select" ? "Choose an option" : model.kind == "color" ? "Choose a color" : "Choose a \(model.kind == "datetime-local" ? "date" : model.kind)"
    navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .cancel, target: self, action: #selector(cancel))
    navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .done, target: self, action: #selector(done))
    navigationItem.rightBarButtonItem?.isEnabled = model.kind != "select" || model.multiple == true || selected.count == 1
    let stack = UIStackView(); stack.axis = .vertical; stack.spacing = 16; stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack); NSLayoutConstraint.activate([stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16), stack.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -16), stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16), stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16)])
    if let notice = model.notice { let label = UILabel(); label.text = notice; label.numberOfLines = 0; label.font = .preferredFont(forTextStyle: .body); stack.addArrangedSubview(label) }
    if model.kind != "select" {
      let parsed = PopupCalendar.parts(draft, kind: model.kind)
      let calendarRepresentable = parsed.map { (1...9999).contains($0.year) } ?? true
      if !calendarRepresentable { let label = UILabel(); label.text = "Use exact entry for this calendar value."; label.numberOfLines = 0; stack.addArrangedSubview(label) }
      if calendarRepresentable && ["date", "time", "datetime-local"].contains(model.kind) {
        let picker = UIDatePicker(); picker.calendar = PopupCalendar.calendar; picker.timeZone = TimeZone(secondsFromGMT: 0)
        picker.datePickerMode = model.kind == "time" ? .time : model.kind == "date" ? .date : .dateAndTime
        picker.preferredDatePickerStyle = .wheels
        if let p = PopupCalendar.parts(draft, kind: model.kind), (1...9999).contains(p.year), let date = PopupCalendar.calendar.date(from: DateComponents(year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second)) { picker.date = date }
        picker.addTarget(self, action: #selector(dateChanged(_:)), for: .valueChanged); stack.addArrangedSubview(picker)
      } else if calendarRepresentable && (model.kind == "month" || model.kind == "week") {
        let picker = UIPickerView(); componentPicker = picker; picker.dataSource = self; picker.delegate = self
        if let p = PopupCalendar.parts(draft,kind: model.kind), (1...9999).contains(p.year) { picker.selectRow(p.year-1,inComponent:0,animated:false); picker.selectRow((model.kind == "month" ? p.month : p.week)-1,inComponent:1,animated:false) }
        stack.addArrangedSubview(picker)
      } else if model.kind == "color" {
        let button = UIButton(type: .system); button.setTitle("Color picker", for: .normal); button.addTarget(self, action: #selector(openColor), for: .touchUpInside); stack.addArrangedSubview(button)
      }
      let label = UILabel(); label.text = model.kind == "color" ? "Exact CSS color (\(model.colorSpace ?? "srgb"))" : "Exact value"; label.font = .preferredFont(forTextStyle: .body); label.adjustsFontForContentSizeCategory = true; stack.addArrangedSubview(label)
      exact.text = draft; exact.borderStyle = .roundedRect; exact.autocorrectionType = .no; exact.autocapitalizationType = .none; exact.accessibilityLabel = label.text; exact.addTarget(self, action: #selector(exactChanged), for: .editingChanged); stack.addArrangedSubview(exact)
    }
    table.rowHeight = UITableView.automaticDimension; table.estimatedRowHeight = 56; table.dataSource = self; table.delegate = self; table.allowsMultipleSelection = model.multiple == true; stack.addArrangedSubview(table)
  }
  func setPending() { pending = true; view.isUserInteractionEnabled = false; navigationItem.rightBarButtonItem?.isEnabled = false; table.isUserInteractionEnabled = false; exact.isEnabled = false }
  func releasePayload() { for cell in table.visibleCells {cell.textLabel?.text=nil;cell.detailTextLabel?.text=nil}; presentedViewController?.dismiss(animated:false); openingResponder = nil; action = nil; model = nil; selected.removeAll(); draft = ""; exact.text = nil; table.dataSource = nil; table.delegate = nil; componentPicker?.delegate = nil; componentPicker?.dataSource = nil }
  @objc private func cancel() { action?(nil) }
  @objc private func done() { guard let model, !pending else { return }; action?(model.kind == "select" ? ["itemIds": Array(selected)] : ["value": draft]) }
  @objc private func exactChanged() { draft = exact.text ?? "" }
  @objc private func dateChanged(_ picker: UIDatePicker) {
    guard let model else { return }; var p = PopupCalendar.parts(draft, kind: model.kind) ?? PopupCalendar.Parts()
    let c = PopupCalendar.calendar.dateComponents([.year,.month,.day,.hour,.minute], from: picker.date)
    if model.kind != "time" { p.year = c.year!; p.month = c.month!; p.day = c.day! }
    if model.kind != "date" { p.hour = c.hour!; p.minute = c.minute! }
    draft = p.value(model.kind); exact.text = draft
  }
  @objc private func openColor() {
    guard let model, !pending else { return }; let picker = UIColorPickerViewController(); picker.supportsAlpha = model.alpha == true; picker.delegate = self
    // Exact CSS remains the source until a deliberate native color edit.
    if let color = Self.parseColor(draft, space: model.colorSpace ?? "srgb") { picker.selectedColor = color }
    else { return }
    present(picker, animated: true)
  }
  func colorPickerViewControllerDidSelectColor(_ picker: UIColorPickerViewController) {
    guard let model else { return }; let space = model.colorSpace == "display-p3" ? CGColorSpace.displayP3 : CGColorSpace.sRGB
    guard let target = CGColorSpace(name: space), let color = picker.selectedColor.cgColor.converted(to: target,intent:.relativeColorimetric,options:nil), let components = color.components, components.count == 4 else { return }
    draft = "color(\(model.colorSpace ?? "srgb") \(components[0]) \(components[1]) \(components[2]) / \(model.alpha == true ? components[3] : 1))"; exact.text = draft
  }
  private static func parseColor(_ value: String, space: String) -> UIColor? {
    if value.hasPrefix("#"), [7,9].contains(value.count), let bits = UInt64(value.dropFirst(),radix:16) {
      let alpha = value.count == 9 ? CGFloat(bits & 255)/255 : 1, rgb = value.count == 9 ? bits >> 8 : bits
      return UIColor(red:CGFloat((rgb>>16)&255)/255,green:CGFloat((rgb>>8)&255)/255,blue:CGFloat(rgb&255)/255,alpha:alpha)
    }
    let pattern = "^color\\((srgb|display-p3) ([0-9.]+) ([0-9.]+) ([0-9.]+)(?: / ([0-9.]+))?\\)$"
    guard let regex = try? NSRegularExpression(pattern:pattern), let match = regex.firstMatch(in:value,range:NSRange(value.startIndex...,in:value)) else { return nil }
    func part(_ index:Int) -> String { guard let range=Range(match.range(at:index),in:value) else{return "1"};return String(value[range]) }
    guard let r=Double(part(2)),let g=Double(part(3)),let b=Double(part(4)),let a=Double(part(5)) else{return nil}
    return part(1)=="display-p3" ? UIColor(displayP3Red:CGFloat(r),green:CGFloat(g),blue:CGFloat(b),alpha:CGFloat(a)) : UIColor(red:CGFloat(r),green:CGFloat(g),blue:CGFloat(b),alpha:CGFloat(a))
  }
  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { action?(nil) }
  func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { model?.items.count ?? 0 }
  func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
    let cell = UITableViewCell(style:.subtitle,reuseIdentifier:nil); guard let i=model?.items[indexPath.row] else{return cell}
    cell.textLabel?.text=i.kind == "separator" ? "────────" : i.label; cell.detailTextLabel?.text=i.secondaryLabel
    cell.textLabel?.font = .preferredFont(forTextStyle: i.kind == "group" ? .headline : .body); cell.textLabel?.adjustsFontForContentSizeCategory=true; cell.textLabel?.numberOfLines=0
    cell.isUserInteractionEnabled=i.enabled && (i.kind == "option" || i.kind == "suggestion"); cell.textLabel?.textColor=i.enabled ? .label : .secondaryLabel
    cell.accessoryType=selected.contains(i.id) || i.selected && !i.enabled ? .checkmark : .none
    if selected.contains(i.id) || i.selected && !i.enabled {cell.accessibilityTraits.insert(.selected)}
    cell.semanticContentAttribute=i.rtl ? .forceRightToLeft : .forceLeftToRight; return cell
  }
  func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
    guard let model,!pending else{return};let item=model.items[indexPath.row];guard item.enabled && (item.kind == "option" || item.kind == "suggestion") else{return}
    if model.kind == "select" && model.multiple == true {if selected.contains(item.id){selected.remove(item.id)}else{selected.insert(item.id)};tableView.reloadData()}
    else {action?(["itemIds":[item.id]])}
  }
  func numberOfComponents(in pickerView: UIPickerView) -> Int { 2 }
  func pickerView(_ pickerView: UIPickerView, numberOfRowsInComponent component: Int) -> Int { component == 0 ? 9999 : model?.kind == "month" ? 12 : 53 }
  func pickerView(_ pickerView: UIPickerView, titleForRow row:Int,forComponent component:Int)->String? { component == 0 ? String(row+1) : model?.kind == "month" ? String(row+1) : "Week \(row+1)" }
  func pickerView(_ pickerView: UIPickerView,didSelectRow row:Int,inComponent component:Int) {guard let model else{return}; var p=PopupCalendar.Parts();p.year=pickerView.selectedRow(inComponent:0)+1;p.month=pickerView.selectedRow(inComponent:1)+1;p.week=p.month;draft=p.value(model.kind);exact.text=draft}
}

private final class PopupFirstResponder: NSObject { weak var value: UIResponder? }
private extension UIResponder {
  @objc func capturePopupResponder(_ sender: PopupFirstResponder) {sender.value = self}
}
