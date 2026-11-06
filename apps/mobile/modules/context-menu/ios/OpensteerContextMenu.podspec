Pod::Spec.new do |s|
  s.name = 'OpensteerContextMenu'
  s.version = '1.0.0'
  s.summary = 'The system context menu around a React Native view'
  s.description = 'UIContextMenuInteraction with a targeted preview, for holding a message.'
  s.license = { :type => 'MIT' }
  s.author = 'Opensteer'
  s.homepage = 'https://opensteer.com'
  s.platforms = { :ios => '16.0' }
  s.swift_version = '5.9'
  s.source = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'UIKit'
  s.source_files = 'ContextMenuModule.swift'
end
