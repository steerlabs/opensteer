Pod::Spec.new do |s|
  s.name = 'OpensteerPasteTarget'
  s.version = '1.0.0'
  s.summary = 'Images pasted into a React Native text field'
  s.description = 'Takes the images a Paste delivers to the text field it holds, as private files.'
  s.license = { :type => 'MIT' }
  s.author = 'Opensteer'
  s.homepage = 'https://opensteer.com'
  s.platforms = { :ios => '16.0' }
  s.swift_version = '5.9'
  s.source = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'UIKit', 'UniformTypeIdentifiers'
  s.source_files = 'PasteTargetModule.swift'
end
