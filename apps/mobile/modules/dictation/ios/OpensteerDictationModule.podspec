Pod::Spec.new do |s|
  s.name = 'OpensteerDictationModule'
  s.version = '1.0.0'
  s.summary = 'Opensteer on-device message dictation'
  s.description = 'Expo bridge to the shared Apple Speech dictation engine.'
  s.license = { :type => 'MIT' }
  s.author = 'Opensteer'
  s.homepage = 'https://opensteer.com'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.dependency 'OpensteerDictation'
  s.frameworks = 'UIKit'
  s.source_files = 'Sources/**/*.swift', 'OpensteerDictationModule.swift'
end
