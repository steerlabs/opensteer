Pod::Spec.new do |s|
  s.name = 'IphoneApps'
  s.version = '1.0.0'
  s.summary = 'Opensteer iPhone Calendar, Contacts and Reminders executor'
  s.description = 'Foreground-only native iPhone integrations executor.'
  s.license = { :type => 'MIT' }
  s.author = 'Opensteer'
  s.homepage = 'https://opensteer.com'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.dependency 'OpensteerAppleData'
  s.frameworks = 'CryptoKit', 'Security', 'EventKit', 'Contacts', 'UIKit', 'CoreLocation', 'Photos', 'PhotosUI'
  s.source_files = 'Sources/IphoneAppsCore/**/*.swift', 'Adapters/**/*.swift', 'IphoneAppsModule.swift'
end
