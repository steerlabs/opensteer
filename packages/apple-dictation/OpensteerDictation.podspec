Pod::Spec.new do |s|
  s.name = 'OpensteerDictation'
  s.version = '1.0.0'
  s.summary = 'Shared on-device dictation engine for Opensteer'
  s.description = 'Microphone capture and on-device Apple SpeechAnalyzer recognition.'
  s.license = { :type => 'MIT' }
  s.author = 'Opensteer'
  s.homepage = 'https://opensteer.com'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :git => '' }
  s.static_framework = true
  s.frameworks = 'Speech', 'AVFoundation'
  s.source_files = 'Sources/OpensteerDictation/**/*.swift'
end
