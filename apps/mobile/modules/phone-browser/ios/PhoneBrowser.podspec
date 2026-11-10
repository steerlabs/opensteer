Pod::Spec.new do |s|
  s.name = 'PhoneBrowser'
  s.version = '1.0.0'
  s.summary = 'Pooled on-device browser views'
  s.description = 'Native phone browser storage, presentation and input primitives.'
  s.license = { :type => 'MIT' }
  s.author = 'Opensteer'
  s.homepage = 'https://opensteer.com'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'UIKit', 'WebKit'
  s.source_files = 'PhoneBrowserModule.swift', 'Core/**/*.swift', 'Native/**/*.swift'
  resources = ['Resources/*.js']
  helper = File.expand_path('../../../src/phone-browser/agent-helper/build.mjs', __dir__)
  if File.file?(helper)
    raise 'Phone browser helper build failed' unless system('node', helper)
    resources << File.join(File.dirname(helper), 'dist/agent-helper.js')
  end
  s.resource_bundles = { 'PhoneBrowser' => resources }
end
