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
  s.dependency 'IphoneApps'
  s.frameworks = 'UIKit', 'WebKit'
  s.source_files = 'PhoneBrowserModule.swift', 'Core/**/*.swift', 'Native/**/*.swift', 'Generated/*.swift'
  resources = ['Resources/*.js']
  helper = File.expand_path('../../../src/phone-browser/agent-helper/build.mjs', __dir__)
  raise 'Phone browser helper build failed' unless system('node', helper, '--swift-output', File.join(__dir__, 'Generated/AgentHelper.swift'))
  s.script_phase = {
    :name => 'Build phone browser helper',
    :script => 'set -e; export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"; node "${PODS_TARGET_SRCROOT}/../../../src/phone-browser/agent-helper/build.mjs" --swift-output "${PODS_TARGET_SRCROOT}/Generated/AgentHelper.swift"',
    :execution_position => :before_compile,
    :always_out_of_date => '1'
  }
  s.resource_bundles = { 'PhoneBrowser' => resources }
end
