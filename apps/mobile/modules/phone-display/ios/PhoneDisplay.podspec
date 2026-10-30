Pod::Spec.new do |s|
  s.name = 'PhoneDisplay'
  s.version = '1.0.0'
  s.summary = 'Opensteer live phone display surface'
  s.description = 'Native H.264 and picture decoding for shared display and browser transports.'
  s.license = { :type => 'MIT' }
  s.author = 'Opensteer'
  s.homepage = 'https://opensteer.com'
  s.platforms = { :ios => '16.0' }
  s.swift_version = '5.9'
  s.source = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'CoreMedia', 'ImageIO'
  s.source_files = 'PhoneDisplayModule.swift', 'Core/*.swift'
end
