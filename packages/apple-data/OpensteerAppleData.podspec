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
