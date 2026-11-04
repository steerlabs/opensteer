Pod::Spec.new do |s|
  s.name = 'BrowserPopup'
  s.version = '1.0.0'
  s.summary = 'Transient browser-owned picker presentation'
  s.description = s.summary
  s.author = 'Opensteer'
  s.homepage = 'https://opensteer.com'
  s.license = 'MIT'
  s.platforms = { :ios => '16.4' }
  s.source = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.swift_version = '5.9'
  s.source_files = '**/*.swift'
  s.exclude_files = 'Tests/**', 'Package.swift'
end
