import UIKit

@main final class FixtureDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    let controller = UIViewController()
    controller.view.backgroundColor = .white
    let input = RemoteInputTextView()
    input.frame = CGRect(x: 20, y: 100, width: 340, height: 300)
    input.autoresizingMask = [.flexibleWidth]
    input.accessibilityIdentifier = "remote-text-proxy"
    controller.view.addSubview(input)
    let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    let output = directory.appendingPathComponent("events.jsonl")
    FileManager.default.createFile(atPath: output.path, contents: nil)
    let file = try! FileHandle(forWritingTo: output)
    input.deliver = { packet in
      if let bytes = try? JSONSerialization.data(withJSONObject: packet, options: [.sortedKeys]) {
        file.write(bytes); file.write(Data([10])); file.synchronizeFile()
      }
      DispatchQueue.main.async { input.respond(["id": packet["id"]!]) }
    }
    let window = UIWindow(frame: UIScreen.main.bounds)
    window.rootViewController = controller
    self.window = window
    window.makeKeyAndVisible()
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
      input.configure(["contextId": "00000000-0000-4000-8000-000000000001", "field": ["kind": "text", "multiline": true, "sensitive": false, "autocapitalize": "none"]], focused: true)
    }
    return true
  }
}
