import { waitForOTPCode } from './lib/ms-graph-email.js';

const otp = await waitForOTPCode({
    email: 'blanchekelseyiryss9793@hotmail.com',
    refreshToken: 'M.C510_BAY.0.U.-CuQTcHRliqQRsQwYE5ynYf!M2APzZnEvJ1cZ0BPRQEP8!wJwg8U9mmcCQ9FTGdeOTbEfW0WnFQRdzVXxCq2cRF633K5pUwsJFD7aeS0H4Fzud3Mx6QCsGNdA4fZUXfAK4vNVr*aeOCKBqvCfd3OeOcM4cvPa8P7TDcp1OlJsJf5nOpOCmH11wstWxktTkTcg9aRcGxNthCNn5mQbxBbF9Ie7*wFw!7Z83ZH3rKuT!7AycJJYXGTD588iy!TN!rDL9ZiSnG139W5YHlJaVi!80BxpieVDETjYy9CLYflDkdB6j4gF698bARpXNpX6xgU23As7vfOeClKSOeOVzzWJBQl9PeO8AY!8G9Wo6HEqCVfECRddghkTFKrfPcPoAyiKxg$$',
    clientId: '9e5f94bc-e8a4-4e73-b8be-63364c29d753',
    senderDomain: 'openai.com',
    maxWaitSecs: 15
});

console.log('KẾT QUẢ OTP:', otp);
