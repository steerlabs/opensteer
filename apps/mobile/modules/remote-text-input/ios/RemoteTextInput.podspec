Pod::Spec.new do |s|
  s.name = 'RemoteTextInput'
  s.version = '1.0.0'
  s.summary = 'Native editing proxy for streamed surfaces'
  s.description = 'Ordered UITextInput transactions and hardware keyboard events.'
  s.license = { :type => 'MIT' }
  s.author = 'Opensteer'
  s.homepage = 'https://opensteer.com'
  s.platforms = { :ios => '16.0' }
  s.swift_version = '5.9'
  s.source = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'UIKit', 'UniformTypeIdentifiers'
  s.source_files = 'RemoteTextInputModule.swift', 'Core/*.swift'
end
