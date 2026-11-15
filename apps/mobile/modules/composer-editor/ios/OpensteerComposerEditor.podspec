Pod::Spec.new do |s|
  s.name = 'OpensteerComposerEditor'
  s.version = '1.0.0'
  s.summary = 'Composer text with atomic reference chips'
  s.description = 'A UIKit text view that shows Markdown references as atomic chips over a plain Markdown source.'
  s.license = { :type => 'MIT' }
  s.author = 'Opensteer'
  s.homepage = 'https://opensteer.com'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'UIKit', 'UniformTypeIdentifiers'
  s.source_files = 'ComposerEditorModule.swift', 'ComposerEditorView.swift', 'PastedImages.swift', 'Core/**/*.swift'
end
