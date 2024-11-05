document.addEventListener("DOMContentLoaded", async function () {
    const totalSteps = 7;
    let currentStep = 1;
    let plaidPassed = false;
    let reservationNumber = sessionStorage.getItem('reservationNumber');
    let plaidHandler = null;

    // Function to check if the current reservation number is tied to a completed reservation
    async function checkReservationStatus() {
        if (reservationNumber) {
            try {
                const response = await fetch(`/api/check-reservation/${reservationNumber}`);
                const data = await response.json();
                if (data.status === 'Confirmed' || !data.exists) {
                    generateNewReservationNumber();
                }
            } catch (error) {
                console.error('Error checking reservation status:', error);
                generateNewReservationNumber();
            }
        } else {
            generateNewReservationNumber();
        }
    }

    // Function to generate a new reservation number and save it
    async function generateNewReservationNumber() {
        reservationNumber = `RES-${Math.floor(100000 + Math.random() * 900000)}`;
        sessionStorage.setItem('reservationNumber', reservationNumber);

        try {
            await fetch('/generate-reservation-number', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reservationNumber }),
            });
        } catch (error) {
            console.error('Error generating reservation number:', error);
        }
    }

    // Function to save data to the database at each step
    async function saveToDatabase(data) {
        try {
            await fetch(`/api/save-reservation/${reservationNumber}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            });
        } catch (error) {
            console.error('Error saving to the database:', error);
        }
    }

    // Initial check for reservation status
    await checkReservationStatus();

    // Function to fetch Plaid Link token and create handler
    async function createPlaidVerification() {
        try {
            const response = await fetch('/create-plaid-verification', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reservationNumber }),
            });

            if (!response.ok) {
                throw new Error(`Error ${response.status}`);
            }

            const data = await response.json();
            console.log('Server response:', data);

            const linkToken = data.link_token;

            if (!linkToken) {
                throw new Error('Failed to retrieve link token from server.');
            }

            plaidHandler = Plaid.create({
                token: linkToken,
                onSuccess: async function (public_token, metadata) {
                    console.log('Plaid link successful:', metadata);
                    plaidPassed = true;
                    document.getElementById('identity-status').textContent = 'Passed Identity Verification';
                    document.getElementById('identity-status').style.color = 'green';
                    document.getElementById('next-button-4').style.display = 'inline-block';

                    // Remove any existing resume button
                    document.getElementById('resume-verification-button-container').innerHTML = '';

                    // Update the identity verification ID in the reservation
                    if (metadata && metadata.identity_verification_id) {
                        await updateIdentityVerificationId(metadata.identity_verification_id);
                    }

                    // Fetch verification data and update the fields automatically
                    await fetchAndUpdateVerificationData();
                },
                onExit: function (err, metadata) {
                    if (err != null) {
                        console.error('Plaid link error:', err);
                    }
                    console.log('Plaid link exited:', metadata);

                    // Add resume button on exit
                    addResumeVerificationButton();
                },
            });

            plaidHandler.open();
        } catch (error) {
            console.error('Plaid verification error:', error);
        }
    }

    // Function to update the identity verification ID for the reservation
    async function updateIdentityVerificationId(identityVerificationId) {
        try {
            const response = await fetch(`/api/update-verification-id/${reservationNumber}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ identityVerificationId }),
            });

            if (!response.ok) {
                throw new Error(`Failed to update identity verification ID. Status code: ${response.status}`);
            }

            console.log(`Identity verification ID for reservation ${reservationNumber} updated successfully.`);
        } catch (error) {
            console.error('Error updating identity verification ID:', error);
        }
    }

    // Function to add a resume verification button
    function addResumeVerificationButton() {
        const container = document.getElementById('resume-verification-button-container');
        container.innerHTML = '';

        const button = document.createElement('button');
        button.className = 'button';
        button.innerText = 'Resume Identity Verification';
        button.addEventListener('click', function () {
            if (plaidHandler) {
                plaidHandler.open();
            }
        });

        container.appendChild(button);
    }

    // Function to fetch and update Plaid verification data
    async function fetchAndUpdateVerificationData() {
        try {
            const response = await fetch(`/api/get-verification-data/${reservationNumber}`);
            if (!response.ok) {
                throw new Error('Failed to fetch verification data');
            }
            const data = await response.json();
            if (data.verificationData) {
                document.getElementById('full-name').value = `${data.verificationData.user?.full_name}` || '';
                document.getElementById('address').value = data.verificationData.address || '';
            }
        } catch (error) {
            console.error('Error fetching verification data:', error);
        }
    }

    // Fetch vehicles from the API
    async function fetchVehicles() {
        try {
            const response = await fetch('/api/vehicles');
            if (!response.ok) {
                throw new Error('Network response was not ok');
            }
            const vehicles = await response.json();

            const vehicleSelectionContainer = document.querySelector('.vehicle-selection');
            vehicleSelectionContainer.innerHTML = '';

            vehicles.forEach((vehicle) => {
                const vehicleOption = document.createElement('div');
                vehicleOption.className = 'vehicle-option';
                vehicleOption.dataset.vehicle = vehicle.carName;
                vehicleOption.dataset.price = vehicle.dailyPrice;
                vehicleOption.innerHTML = `
                    <img src="images/${vehicle.model.toLowerCase()}.jpeg" alt="${vehicle.carName}" style="width: 100%; max-width: 150px;">
                    <h3>${vehicle.carName}</h3>
                    <p>$${vehicle.dailyPrice}/day</p>
                `;

                vehicleOption.addEventListener('click', () => {
                    document.querySelectorAll('.vehicle-option').forEach((v) => v.classList.remove('selected'));
                    vehicleOption.classList.add('selected');
                    updateSummary();
                });

                vehicleSelectionContainer.appendChild(vehicleOption);
            });
        } catch (error) {
            console.error('Error fetching vehicles:', error);
            alert('Failed to load vehicles. Please try again later.');
        }
    }

    // Call fetchVehicles to load vehicles on page load
    fetchVehicles();

    // Fetch extras from the API
    async function fetchExtras() {
        try {
            const response = await fetch('/api/extras');
            if (!response.ok) {
                throw new Error('Network response was not ok');
            }
            const extras = await response.json();

            const addonSection = document.querySelector('.addon-section');
            addonSection.innerHTML = '';

            extras.forEach((extra) => {
                const addonOption = document.createElement('div');
                addonOption.className = 'addon-option';
                addonOption.dataset.addon = extra.name;
                addonOption.dataset.price = extra.price;
                addonOption.dataset.daily = extra.priceType === 'daily';
                addonOption.innerHTML = `
                    <h3>${extra.name}</h3>
                    <p>$${extra.price} ${extra.priceType === 'daily' ? '/day' : '/reservation'}</p>
                    <div class="info-bubble" onclick="showInfoPopup('${extra.name}')">i</div>
                `;

                addonOption.addEventListener('click', () => {
                    addonOption.classList.toggle('selected');
                    updateSummary();
                });

                addonSection.appendChild(addonOption);
            });
        } catch (error) {
            console.error('Error fetching extras:', error);
            alert('Failed to load extras. Please try again later.');
        }
    }

    // Call fetchExtras to load extras on page load
    fetchExtras();

    function toEST(date) {
        return new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    }

    let now = new Date();
    now.setMinutes(Math.ceil(now.getMinutes() / 15) * 15);
    now.setHours(now.getHours() + 3);
    now = toEST(now);

    const startDateDefault = new Date(now);
    const endDateDefault = new Date(startDateDefault);
    endDateDefault.setDate(endDateDefault.getDate() + 2);

    flatpickr('#start-date', {
        enableTime: true,
        dateFormat: 'm/d/Y h:i K',
        defaultDate: startDateDefault,
        minDate: 'today',
        minuteIncrement: 15,
        onChange: function (selectedDates) {
            if (selectedDates.length > 0) {
                let minEndDate = new Date(selectedDates[0]);
                minEndDate = toEST(minEndDate);
                minEndDate.setDate(minEndDate.getDate() + 2);
                flatpickr('#end-date', {
                    enableTime: true,
                    dateFormat: 'm/d/Y h:i K',
                    defaultDate: minEndDate,
                    minDate: minEndDate,
                    minuteIncrement: 15,
                });
            }
        },
    });

    flatpickr('#end-date', {
        enableTime: true,
        dateFormat: 'm/d/Y h:i K',
        defaultDate: endDateDefault,
        minDate: 'today',
        minuteIncrement: 15,
    });

    function showStep(step) {
        const stepElement = document.getElementById(`step-${step}`);
        if (stepElement) {
            document.querySelectorAll('.step-container').forEach((container) => {
                container.classList.remove('active');
            });
            stepElement.classList.add('active');
        }

        if (step === 4 && !plaidPassed) {
            createPlaidVerification();
        }

        document.getElementById('prev-button').style.display = step === 1 ? 'none' : 'inline-block';
    }

    function updateSummary() {
        const startDate = document.getElementById('start-date').value;
        const endDate = document.getElementById('end-date').value;
        const selectedVehicle = document.querySelector('.vehicle-option.selected');
        const selectedAddons = document.querySelectorAll('.addon-option.selected');

        document.getElementById('summary-start-date').innerText = startDate;
        document.getElementById('summary-end-date').innerText = endDate;
        document.getElementById('summary-vehicle').innerText = selectedVehicle ? selectedVehicle.dataset.vehicle : '';

        let addonsText = '';
        let totalPrice = selectedVehicle ? parseFloat(selectedVehicle.dataset.price) : 0;
        const start = new Date(startDate);
        const end = new Date(endDate);
        let totalDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
        totalDays = totalDays < 1 ? 1 : totalDays;

        totalPrice *= totalDays;

        selectedAddons.forEach((addon) => {
            addonsText += `${addon.dataset.addon}, `;
            if (addon.dataset.daily === 'true') {
                totalPrice += parseFloat(addon.dataset.price) * totalDays;
            } else {
                totalPrice += parseFloat(addon.dataset.price);
            }
        });

        addonsText = addonsText.slice(0, -2);
        document.getElementById('summary-add-ons').innerText = addonsText;

        totalPrice += totalPrice * 0.075; // Adding tax
        document.getElementById('total-due').innerText = `$${totalPrice.toFixed(2)}`;
    }

    showStep(currentStep);

    document.querySelectorAll('#next-button-1, #next-button-2, #next-button-3, #next-button-4, #next-button-5').forEach((button) => {
        button.addEventListener('click', () => {
            if (button.id === 'next-button-2') {
                const selectedVehicle = document.querySelector('.vehicle-option.selected');
                if (!selectedVehicle) {
                    alert('Please select a vehicle before proceeding.');
                    return;
                }
            }
            if (currentStep < totalSteps) {
                currentStep++;
                showStep(currentStep);
                updateSummary();
            }
        });
    });

    document.getElementById('prev-button').addEventListener('click', () => {
        if (currentStep > 1) {
            currentStep--;
            showStep(currentStep);
            updateSummary();
        }
    });

    document.getElementById('next-button-1').addEventListener('click', () => {
        const startDate = document.getElementById('start-date').value;
        const endDate = document.getElementById('end-date').value;
        saveToDatabase({ startDate, endDate });
    });

    document.getElementById('next-button-3').addEventListener('click', () => {
        const selectedAddons = Array.from(document.querySelectorAll('.addon-option.selected')).map(addon => addon.dataset.addon);
        saveToDatabase({ addons: selectedAddons });
    });

    document.getElementById('confirm-reservation').addEventListener('click', () => {
        const fullName = document.getElementById('full-name').value;
        const email = document.getElementById('email').value;
        const phone = document.getElementById('phone').value;
        const address = document.getElementById('address').value;

        saveToDatabase({ fullName, email, phone, address, status: 'Pending' });
        currentStep++;
        showStep(currentStep);
    });
});
