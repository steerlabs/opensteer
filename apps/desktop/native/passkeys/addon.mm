#import <AppKit/AppKit.h>
#import <AuthenticationServices/AuthenticationServices.h>
#import <Security/SecTask.h>
#include <node_api.h>
#include <cmath>
#include <algorithm>
#include <string>
#include <cstring>

@class PasskeyOperation;
struct AddonState {
  NSMutableDictionary<NSString *, PasskeyOperation *> *operations;
};

static bool Available() {
  if (![NSThread isMainThread]) return false;
  if (@available(macOS 13.5, *)) {
    SecTaskRef task = SecTaskCreateFromSelf(kCFAllocatorDefault);
    if (!task) return false;
    CFTypeRef value = SecTaskCopyValueForEntitlement(
        task, CFSTR("com.apple.developer.web-browser.public-key-credential"), nullptr);
    bool allowed = value && CFGetTypeID(value) == CFBooleanGetTypeID() &&
                   CFBooleanGetValue((CFBooleanRef)value);
    if (value) CFRelease(value);
    CFRelease(task);
    return allowed;
  }
  return false;
}

static NSString *String(napi_env env, napi_value value, size_t limit) {
  napi_valuetype type;
  size_t length;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok ||
      length > limit) return nil;
  std::string buffer(length + 1, '\0');
  if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length) != napi_ok) return nil;
  return [[NSString alloc] initWithBytes:buffer.data() length:length encoding:NSUTF8StringEncoding];
}
static napi_value Undefined(napi_env env) {
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}
static NSData *Bytes(NSString *base64) {
  return [[NSData alloc] initWithBase64EncodedString:base64 options:0];
}
static NSString *Base64(NSData *data) { return [data base64EncodedStringWithOptions:0]; }
static NSDictionary *Failure(NSString *domain, NSInteger code) {
  return @{ @"kind": @"error", @"domain": domain, @"code": @(code) };
}
// Cocoa may call back outside a Node callback scope. Let N-API enter JS on its own loop.
static void CallJavaScript(napi_env env, napi_value callback, void *context, void *data) {
  NSDictionary *result = CFBridgingRelease(data);
  if (!env || !callback) return;
  NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:nullptr];
  napi_value receiver, argument, ignored;
  if (json && napi_get_undefined(env, &receiver) == napi_ok &&
      napi_create_string_utf8(env, (const char *)json.bytes, json.length, &argument) == napi_ok) {
    napi_call_function(env, receiver, callback, 1, &argument, &ignored);
  }
}
static napi_threadsafe_function Completion(napi_env env, napi_value callback) {
  napi_value name;
  napi_create_string_utf8(env, "Opensteer passkey completion", NAPI_AUTO_LENGTH, &name);
  napi_threadsafe_function completion = nullptr;
  if (napi_create_threadsafe_function(env, callback, nullptr, name, 1, 1, nullptr,
      nullptr, nullptr, CallJavaScript, &completion) != napi_ok) return nullptr;
  return completion;
}
static void Reply(napi_threadsafe_function completion, NSDictionary *result) {
  void *data = (void *)CFBridgingRetain(result);
  if (napi_call_threadsafe_function(completion, data, napi_tsfn_nonblocking) != napi_ok) CFRelease(data);
  napi_release_threadsafe_function(completion, napi_tsfn_release);
}

// This object owns every AS collaborator, but never the presenting window.
API_AVAILABLE(macos(13.5))
@interface PasskeyOperation : NSObject <ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding>
@property(nonatomic) AddonState *state;
@property(nonatomic) napi_threadsafe_function completion;
@property(nonatomic, copy) NSString *operationId;
@property(nonatomic) NSInteger windowNumber;
@property(nonatomic) double deadline;
@property(nonatomic) BOOL settled;
@property(nonatomic, strong) ASAuthorizationController *controller;
@property(nonatomic, strong) id closeObserver;
@property(nonatomic, strong) dispatch_source_t timer;
- (void)finish:(NSDictionary *)result cancel:(BOOL)cancel;
- (void)abandon;
@end

API_AVAILABLE(macos(13.5))
static NSArray *Descriptors(NSArray *credentials, BOOL platform) {
  NSMutableArray *result = [NSMutableArray array];
  for (NSDictionary *credential in credentials) {
    NSData *identifier = Bytes(credential[@"id"]);
    if (platform) {
      [result addObject:[[ASAuthorizationPlatformPublicKeyCredentialDescriptor alloc] initWithCredentialID:identifier]];
    } else {
      NSMutableArray *transports = [NSMutableArray array];
      for (NSString *transport in credential[@"transports"]) {
        if ([transport isEqual:@"usb"]) [transports addObject:ASAuthorizationSecurityKeyPublicKeyCredentialDescriptorTransportUSB];
        if ([transport isEqual:@"nfc"]) [transports addObject:ASAuthorizationSecurityKeyPublicKeyCredentialDescriptorTransportNFC];
        if ([transport isEqual:@"ble"]) [transports addObject:ASAuthorizationSecurityKeyPublicKeyCredentialDescriptorTransportBluetooth];
      }
      [result addObject:[[ASAuthorizationSecurityKeyPublicKeyCredentialDescriptor alloc] initWithCredentialID:identifier transports:transports]];
    }
  }
  return result;
}

API_AVAILABLE(macos(13.5))
static NSArray<ASAuthorizationRequest *> *Requests(NSDictionary *plan) {
  ASPublicKeyCredentialClientData *clientData = [[ASPublicKeyCredentialClientData alloc]
      initWithChallenge:Bytes(plan[@"challenge"]) origin:plan[@"origin"]];
  clientData.crossOrigin = ASPublicKeyCredentialClientDataCrossOriginValueSameOriginWithAncestors;
  BOOL create = [plan[@"op"] isEqual:@"create"];
  NSDictionary *user = plan[@"user"];
  NSMutableArray<ASAuthorizationRequest *> *requests = [NSMutableArray array];
  for (NSString *kind in plan[@"providers"]) {
    if ([kind isEqual:@"platform"]) {
      id<ASAuthorizationWebBrowserPlatformPublicKeyCredentialProvider> provider =
          [[ASAuthorizationPlatformPublicKeyCredentialProvider alloc] initWithRelyingPartyIdentifier:plan[@"rpId"]];
      if (create) {
        ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest *request =
            [provider createCredentialRegistrationRequestWithClientData:clientData name:user[@"name"] userID:Bytes(user[@"id"])];
        request.displayName = user[@"displayName"];
        request.userVerificationPreference = plan[@"userVerification"];
        request.attestationPreference = ASAuthorizationPublicKeyCredentialAttestationKindNone;
        id<ASAuthorizationWebBrowserPlatformPublicKeyCredentialRegistrationRequest> browser = request;
        browser.excludedCredentials = Descriptors(plan[@"credentials"], YES);
        browser.shouldShowHybridTransport = [plan[@"shouldShowHybridTransport"] boolValue];
        [requests addObject:request];
      } else {
        ASAuthorizationPlatformPublicKeyCredentialAssertionRequest *request =
            [provider createCredentialAssertionRequestWithClientData:clientData];
        request.userVerificationPreference = plan[@"userVerification"];
        request.allowedCredentials = Descriptors(plan[@"credentials"], YES);
        id<ASAuthorizationWebBrowserPlatformPublicKeyCredentialAssertionRequest> browser = request;
        browser.shouldShowHybridTransport = [plan[@"shouldShowHybridTransport"] boolValue];
        [requests addObject:request];
      }
    } else if ([kind isEqual:@"security-key"]) {
      if (@available(macOS 14.4, *)) {
        id<ASAuthorizationWebBrowserSecurityKeyPublicKeyCredentialProvider> provider =
            [[ASAuthorizationSecurityKeyPublicKeyCredentialProvider alloc] initWithRelyingPartyIdentifier:plan[@"rpId"]];
        if (create) {
          ASAuthorizationSecurityKeyPublicKeyCredentialRegistrationRequest *request =
              [provider createCredentialRegistrationRequestWithClientData:clientData displayName:user[@"displayName"] name:user[@"name"] userID:Bytes(user[@"id"])];
          request.userVerificationPreference = plan[@"userVerification"];
          request.attestationPreference = ASAuthorizationPublicKeyCredentialAttestationKindNone;
          request.residentKeyPreference = plan[@"residentKey"];
          request.excludedCredentials = Descriptors(plan[@"credentials"], NO);
          NSMutableArray *parameters = [NSMutableArray array];
          for (NSNumber *algorithm in plan[@"algorithms"]) [parameters addObject:[[ASAuthorizationPublicKeyCredentialParameters alloc] initWithAlgorithm:algorithm.integerValue]];
          request.credentialParameters = parameters;
          [requests addObject:request];
        } else {
          ASAuthorizationSecurityKeyPublicKeyCredentialAssertionRequest *request = [provider createCredentialAssertionRequestWithClientData:clientData];
          request.userVerificationPreference = plan[@"userVerification"];
          request.allowedCredentials = Descriptors(plan[@"credentials"], NO);
          [requests addObject:request];
        }
      }
    }
  }
  return requests;
}

@implementation PasskeyOperation
- (void)cleanup {
  if (_timer) { dispatch_source_cancel(_timer); _timer = nil; }
  if (_closeObserver) { [[NSNotificationCenter defaultCenter] removeObserver:_closeObserver]; _closeObserver = nil; }
  _controller.delegate = nil;
  _controller.presentationContextProvider = nil;
}
- (void)finish:(NSDictionary *)result cancel:(BOOL)cancel {
  if (_settled) return;
  _settled = YES;
  // Hold self while removing the owning dictionary entry and invoking JS.
  PasskeyOperation *keepAlive = self;
  ASAuthorizationController *controller = _controller;
  [self cleanup];
  [_state->operations removeObjectForKey:_operationId];
  napi_threadsafe_function completion = _completion;
  _completion = nullptr;
  if (completion) Reply(completion, result);
  if (cancel) [controller cancel];
  keepAlive.controller = nil;
}
- (void)abandon {
  if (_settled) return;
  _settled = YES;
  [self cleanup];
  if (_completion) { napi_release_threadsafe_function(_completion, napi_tsfn_abort); _completion = nullptr; }
  [_controller cancel];
  _controller = nil;
}
- (ASPresentationAnchor)presentationAnchorForAuthorizationController:(ASAuthorizationController *)controller {
  NSWindow *window = [NSApp windowWithWindowNumber:_windowNumber];
  if (_settled || !window || NSDate.date.timeIntervalSince1970 * 1000 >= _deadline) {
    [self finish:Failure(@"OpensteerPasskeys", 1) cancel:YES];
    return nil;
  }
  return window;
}
- (void)authorizationController:(ASAuthorizationController *)controller didCompleteWithError:(NSError *)error {
  if (![NSThread isMainThread]) {
    dispatch_async(dispatch_get_main_queue(), ^{ [self authorizationController:controller didCompleteWithError:error]; });
    return;
  }
  [self finish:Failure(error.domain, error.code) cancel:NO];
}
- (void)authorizationController:(ASAuthorizationController *)controller didCompleteWithAuthorization:(ASAuthorization *)authorization {
  if (![NSThread isMainThread]) {
    dispatch_async(dispatch_get_main_queue(), ^{ [self authorizationController:controller didCompleteWithAuthorization:authorization]; });
    return;
  }
  if (_settled) return;
  if (NSDate.date.timeIntervalSince1970 * 1000 >= _deadline || ![NSApp windowWithWindowNumber:_windowNumber]) {
    [self finish:Failure(@"OpensteerPasskeys", 1) cancel:YES];
    return;
  }
  id credential = authorization.credential;
  BOOL platformCreate = [credential isKindOfClass:ASAuthorizationPlatformPublicKeyCredentialRegistration.class];
  BOOL platformGet = [credential isKindOfClass:ASAuthorizationPlatformPublicKeyCredentialAssertion.class];
  BOOL keyCreate = [credential isKindOfClass:ASAuthorizationSecurityKeyPublicKeyCredentialRegistration.class];
  BOOL keyGet = [credential isKindOfClass:ASAuthorizationSecurityKeyPublicKeyCredentialAssertion.class];
  if (!platformCreate && !platformGet && !keyCreate && !keyGet) {
    [self finish:Failure(@"OpensteerPasskeys", 2) cancel:NO];
    return;
  }
  id<ASPublicKeyCredential> publicKey = credential;
  NSString *attachment = @"cross-platform";
  if (platformCreate) attachment = ((ASAuthorizationPlatformPublicKeyCredentialRegistration *)credential).attachment == ASAuthorizationPublicKeyCredentialAttachmentPlatform ? @"platform" : @"cross-platform";
  if (platformGet) attachment = ((ASAuthorizationPlatformPublicKeyCredentialAssertion *)credential).attachment == ASAuthorizationPublicKeyCredentialAttachmentPlatform ? @"platform" : @"cross-platform";
  NSMutableDictionary *result = [@{ @"kind": (platformCreate || keyCreate) ? @"created" : @"asserted", @"provider": (platformCreate || platformGet) ? @"platform" : @"security-key", @"attachment": attachment, @"credentialID": Base64(publicKey.credentialID), @"rawClientDataJSON": Base64(publicKey.rawClientDataJSON) } mutableCopy];
  if (platformCreate || keyCreate) {
    id<ASAuthorizationPublicKeyCredentialRegistration> registration = credential;
    if (!registration.rawAttestationObject) { [self finish:Failure(@"OpensteerPasskeys", 2) cancel:NO]; return; }
    result[@"rawAttestationObject"] = Base64(registration.rawAttestationObject);
    result[@"transports"] = NSNull.null;
    if (keyCreate) {
      if (@available(macOS 14.5, *)) {
        NSMutableArray *transports = [NSMutableArray array];
        for (NSString *transport in ((ASAuthorizationSecurityKeyPublicKeyCredentialRegistration *)credential).transports) {
          if ([transport isEqual:ASAuthorizationSecurityKeyPublicKeyCredentialDescriptorTransportUSB]) [transports addObject:@"usb"];
          if ([transport isEqual:ASAuthorizationSecurityKeyPublicKeyCredentialDescriptorTransportNFC]) [transports addObject:@"nfc"];
          if ([transport isEqual:ASAuthorizationSecurityKeyPublicKeyCredentialDescriptorTransportBluetooth]) [transports addObject:@"ble"];
        }
        result[@"transports"] = transports;
      }
    }
  } else {
    id<ASAuthorizationPublicKeyCredentialAssertion> assertion = credential;
    result[@"rawAuthenticatorData"] = Base64(assertion.rawAuthenticatorData);
    result[@"signature"] = Base64(assertion.signature);
    result[@"userID"] = assertion.userID ? Base64(assertion.userID) : (id)NSNull.null;
  }
  [self finish:result cancel:NO];
}
@end

static napi_value IsAvailable(napi_env env, napi_callback_info info) {
  napi_value value;
  napi_get_boolean(env, Available(), &value);
  return value;
}
static napi_value Capabilities(napi_env env, napi_callback_info info) {
  napi_value result, keys;
  napi_create_object(env, &result);
  bool securityKeys = false;
  if (@available(macOS 14.4, *)) securityKeys = true;
  napi_get_boolean(env, securityKeys, &keys);
  napi_set_named_property(env, result, "securityKeys", keys);
  return result;
}
static napi_value WindowNumber(napi_env env, napi_callback_info info) {
  napi_value argument, result;
  size_t argc = 1, length = 0;
  void *data = nullptr;
  bool buffer = false;
  napi_get_cb_info(env, info, &argc, &argument, nullptr, nullptr);
  if (argc != 1 || napi_is_buffer(env, argument, &buffer) != napi_ok || !buffer ||
      napi_get_buffer_info(env, argument, &data, &length) != napi_ok || length != sizeof(void *) || ![NSThread isMainThread]) {
    napi_throw_type_error(env, nullptr, "Expected Electron native window handle"); return nullptr;
  }
  void *pointer;
  memcpy(&pointer, data, sizeof(pointer));
  // Electron's macOS handle is an NSView*, not an NSWindow* or its number.
  NSView *view = (__bridge NSView *)pointer;
  napi_create_int64(env, view ? view.window.windowNumber : 0, &result);
  return result;
}
static napi_value Start(napi_env env, napi_callback_info info) {
  napi_value args[2];
  size_t argc = 2;
  void *context = nullptr;
  napi_get_cb_info(env, info, &argc, args, nullptr, &context);
  napi_valuetype callbackType;
  NSString *json = argc == 2 ? String(env, args[0], 200000) : nil;
  if (!json || napi_typeof(env, args[1], &callbackType) != napi_ok || callbackType != napi_function) {
    napi_throw_type_error(env, nullptr, "Expected passkey plan and callback"); return nullptr;
  }
  napi_threadsafe_function completion = Completion(env, args[1]);
  if (!completion) { napi_throw_error(env, nullptr, "Could not create passkey completion"); return nullptr; }
  if (!Available()) {
    Reply(completion, Failure(@"OpensteerPasskeys", 3));
    return Undefined(env);
  }
  if (@available(macOS 13.5, *)) {
    NSDictionary *plan = [NSJSONSerialization JSONObjectWithData:[json dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nullptr];
    AddonState *state = (AddonState *)context;
    if (![plan isKindOfClass:NSDictionary.class] || ![plan[@"operationId"] isKindOfClass:NSString.class] || state->operations[plan[@"operationId"]]) {
      Reply(completion, Failure(@"OpensteerPasskeys", 2));
      return Undefined(env);
    }
    PasskeyOperation *operation = [PasskeyOperation new];
    operation.state = state;
    operation.completion = completion;
    operation.operationId = plan[@"operationId"];
    operation.windowNumber = [plan[@"windowNumber"] integerValue];
    operation.deadline = [plan[@"deadline"] doubleValue];
    state->operations[operation.operationId] = operation;
    double remaining = operation.deadline - NSDate.date.timeIntervalSince1970 * 1000;
    if (!std::isfinite(remaining) || remaining <= 0 || ![NSApp windowWithWindowNumber:operation.windowNumber]) {
      [operation finish:Failure(@"OpensteerPasskeys", 1) cancel:NO];
      return Undefined(env);
    }
    @try {
      NSArray *requests = Requests(plan);
      if (!requests.count) { [operation finish:Failure(@"OpensteerPasskeys", 2) cancel:NO]; return Undefined(env); }
      operation.controller = [[ASAuthorizationController alloc] initWithAuthorizationRequests:requests];
      operation.controller.delegate = operation;
      operation.controller.presentationContextProvider = operation;
      __weak PasskeyOperation *weakOperation = operation;
      operation.closeObserver = [[NSNotificationCenter defaultCenter] addObserverForName:NSWindowWillCloseNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *notification) {
        PasskeyOperation *current = weakOperation;
        if (current && ((NSWindow *)notification.object).windowNumber == current.windowNumber) [current finish:Failure(@"OpensteerPasskeys", 1) cancel:YES];
      }];
      operation.timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
      dispatch_source_set_timer(operation.timer, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(std::min(remaining, 2147483647.0) * NSEC_PER_MSEC)), DISPATCH_TIME_FOREVER, 0);
      dispatch_source_set_event_handler(operation.timer, ^{ [weakOperation finish:Failure(@"OpensteerPasskeys", 1) cancel:YES]; });
      dispatch_resume(operation.timer);
      [operation.controller performRequests];
    } @catch (NSException *exception) {
      [operation finish:Failure(@"OpensteerPasskeys", 2) cancel:YES];
    }
  }
  return Undefined(env);
}
static napi_value Cancel(napi_env env, napi_callback_info info) {
  napi_value argument;
  size_t argc = 1;
  void *context = nullptr;
  napi_get_cb_info(env, info, &argc, &argument, nullptr, &context);
  NSString *operationId = argc ? String(env, argument, 256) : nil;
  if (@available(macOS 13.5, *)) {
    if (operationId) [((AddonState *)context)->operations[operationId] finish:Failure(@"OpensteerPasskeys", 1) cancel:YES];
  }
  return Undefined(env);
}
static void Cleanup(void *context) {
  AddonState *state = (AddonState *)context;
  if (@available(macOS 13.5, *)) {
    for (PasskeyOperation *operation in state->operations.allValues) [operation abandon];
  }
  [state->operations removeAllObjects];
  delete state;
}
static napi_value Initialize(napi_env env, napi_value exports) {
  AddonState *state = new AddonState{[NSMutableDictionary dictionary]};
  napi_add_env_cleanup_hook(env, Cleanup, state);
  const napi_property_descriptor properties[] = {
    {"available", nullptr, IsAvailable, nullptr, nullptr, nullptr, napi_default, state},
    {"capabilities", nullptr, Capabilities, nullptr, nullptr, nullptr, napi_default, state},
    {"windowNumber", nullptr, WindowNumber, nullptr, nullptr, nullptr, napi_default, state},
    {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, state},
    {"cancel", nullptr, Cancel, nullptr, nullptr, nullptr, napi_default, state},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}
NAPI_MODULE(opensteer_passkeys, Initialize)
