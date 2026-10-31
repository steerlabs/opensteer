Pod::Spec.new do |s|
  s.name = 'OpensteerNotificationPreview'
  s.version = '1.0.0'
  s.summary = 'Private local notification previews'
  s.description = s.summary
  s.license = { :type => 'MIT' }
  s.author = 'Opensteer'
  s.homepage = 'https://opensteer.com'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CryptoKit', 'Security'
  s.source_files = 'Sources/**/*.swift', 'NotificationPreviewModule.swift'
end
