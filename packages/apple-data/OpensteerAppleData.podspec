# SwiftPM synthesizes PackageResources for embedInCode; CocoaPods does not.
# Embed the same catalog bytes without introducing a runtime resource bundle.
require 'base64'
contracts = File.read(File.join(__dir__, 'Sources/OpensteerAppleData/Resources/contracts.json'))
File.write(File.join(__dir__, 'Sources/OpensteerAppleData/PackageResources.generated.swift'),
  "#if !SWIFT_PACKAGE\nimport Foundation\nenum PackageResources {\n  static let contracts_json = Data(base64Encoded: \"#{Base64.strict_encode64(contracts)}\")!\n}\n#endif\n")

Pod::Spec.new do |s|
  s.name = 'OpensteerAppleData'
  s.version = '1.0.0'
  s.summary = 'Shared Calendar, Reminders and Contacts providers for Opensteer'
  s.description = 'One source of Apple data parsing and public API providers.'
  s.license = { :type => 'MIT' }
  s.author = 'Opensteer'
  s.homepage = 'https://opensteer.com'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :git => '' }
  s.static_framework = true
  s.frameworks = 'EventKit', 'Contacts'
  s.source_files = 'Sources/OpensteerAppleData/**/*.swift'
end
