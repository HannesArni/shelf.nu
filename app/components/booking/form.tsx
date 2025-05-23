import { useEffect, useState } from "react";
import { BookingStatus } from "@prisma/client";
import { useLoaderData, useNavigation } from "@remix-run/react";
import { useAtom } from "jotai";
import { useZorm } from "react-zorm";
import { z } from "zod";
import { updateDynamicTitleAtom } from "~/atoms/dynamic-title-atom";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/shared/tooltip";
import { useBookingStatusHelpers } from "~/hooks/use-booking-status";
import type { ModelFilterItem } from "~/hooks/use-model-filters";
import { useUserRoleHelper } from "~/hooks/user-user-role-helper";
import type { loader } from "~/routes/_layout+/bookings.new";
import { type getHints } from "~/utils/client-hints";
import { dateForDateTimeInputValue } from "~/utils/date-fns";
import { isFormProcessing } from "~/utils/form";
import { userCanViewSpecificCustody } from "~/utils/permissions/custody-and-bookings-permissions.validator.client";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { userHasPermission } from "~/utils/permissions/permission.validator.client";
import { tw } from "~/utils/tw";
import { resolveTeamMemberName } from "~/utils/user";
import { ActionsDropdown } from "./actions-dropdown";
import { Form } from "../custom-form";
import BookingProcessSidebar from "./booking-process-sidebar";
import CheckinDialog from "./checkin-dialog";
import CheckoutDialog from "./checkout-dialog";
import DynamicSelect from "../dynamic-select/dynamic-select";
import FormRow from "../forms/form-row";
import Input from "../forms/input";
import { AbsolutePositionedHeaderActions } from "../layout/header/absolute-positioned-header-actions";
import { Button } from "../shared/button";
import { Card } from "../shared/card";
import When from "../when/when";

/**
 * Returns a Zod validation schema for the booking form based on the action and booking status.
 *
 * Validation logic depends on two factors: the booking `status` and the `action` being performed.
 *
 * - Action: "new"
 *   - All fields are updated.
 *
 * - Action: "save"
 *   - If status is "DRAFT":
 *     - All fields are updated.
 *   - If status is "RESERVED", "ONGOING", or "OVERDUE":
 *     - Only `name` and `description` are updated.
 *
 * - Action: "reserve"
 *   - All fields are updated.
 *
 * - Other actions:
 *   - No relevant fields are updated.
 *   - Only base-level validation applies.
 */
export function BookingFormSchema({
  hints,
  action,
  status,
}: {
  hints?: ReturnType<typeof getHints>;
  action: "new" | "save" | "reserve";
  status?: BookingStatus;
}) {
  /* Base schema which is common in every case */
  const baseSchema = z.object({
    name: z.string().min(2, "Name is required"),
    assetIds: z.array(z.string()).optional(),
    description: z.string().optional(),
    custodian: z
      .string()
      .transform((val, ctx) => {
        if (!val && val === "") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Please select a custodian",
          });
          return z.NEVER;
        }
        return JSON.parse(val);
      })
      .pipe(
        z.object({
          id: z.string(),
          name: z.string(),
          userId: z.string().optional().nullable(),
        })
      ),
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().optional(),
  });

  const startDateSchema = z.coerce.date().refine(
    (data) => {
      let now;
      if (hints?.timeZone) {
        now = new Date(
          new Date().toLocaleString("en-US", {
            timeZone: hints.timeZone,
          })
        );
      } else {
        now = new Date();
      }
      return data > now;
    },
    {
      message: "Start date must be in the future",
    }
  );

  /* Complete schema with all fields */
  const fullSchema = baseSchema.extend({
    startDate: startDateSchema,
    endDate: z.coerce.date(),
  });

  /** Complete schema with id field */
  const fullSchemaWithId = fullSchema
    .extend({ id: z.string() })
    .refine(
      (data) => data.endDate && data.startDate && data.endDate > data.startDate,
      {
        message: "End date cannot be earlier than start date",
        path: ["endDate"],
      }
    );

  switch (action) {
    case "new": {
      return fullSchema.refine(
        (data) =>
          data.endDate && data.startDate && data.endDate > data.startDate,
        {
          message: "End date cannot be earlier than start date",
          path: ["endDate"],
        }
      );
    }

    case "reserve": {
      return fullSchemaWithId;
    }

    case "save": {
      if (!status) {
        throw new Error("Status is required for save action.");
      }

      switch (status) {
        case BookingStatus.DRAFT: {
          return fullSchemaWithId;
        }

        case BookingStatus.RESERVED:
        case BookingStatus.ONGOING:
        case BookingStatus.OVERDUE: {
          return baseSchema;
        }
      }
    }

    default: {
      return baseSchema;
    }
  }
}

type BookingFlags = {
  hasAssets: boolean;
  hasUnavailableAssets: boolean;
  hasCheckedOutAssets: boolean;
  hasAlreadyBookedAssets: boolean;
  hasAssetsInCustody: boolean;
};

type BookingFormData = {
  booking: {
    id?: string;
    name?: string;
    startDate?: string;
    endDate?: string;
    custodianRef?: string; // This is a stringified value for custodianRef. It can be either a team member id or a user id
    bookingFlags?: BookingFlags;
    assetIds?: string[] | null;
    description?: string | null;
    status?: BookingStatus;
  };

  /**
   * In case if the form is rendered outside of /edit or /new booking,
   * then we can pass `action` to submit form
   */
  action?: string;
};

export function BookingForm({ booking, action }: BookingFormData) {
  const navigation = useNavigation();
  const {
    id,
    name,
    startDate,
    endDate: incomingEndDate,
    custodianRef,
    bookingFlags,
    assetIds,
    description,
    status,
  } = booking;

  const bookingStatus = useBookingStatusHelpers(status);
  const { teamMembers, userId, currentOrganization } =
    useLoaderData<typeof loader>();
  const [endDate, setEndDate] = useState(incomingEndDate);
  /** If there is noId, that means we are creating a new booking */
  const isNewBooking = !id;

  const [, updateName] = useAtom(updateDynamicTitleAtom);

  const isProcessing = isFormProcessing(navigation.state);

  const disabled = isProcessing || bookingStatus?.isArchived;

  const inputFieldIsDisabled =
    disabled ||
    Boolean(
      bookingStatus?.isReserved ||
        bookingStatus?.isOngoing ||
        bookingStatus?.isCompleted ||
        bookingStatus?.isOverdue ||
        bookingStatus?.isCancelled
    );

  const zo = useZorm(
    "NewQuestionWizardScreen",
    BookingFormSchema({
      action: isNewBooking ? "new" : "save", // NOTE: in the front-end the action save basically handles the schema for reserve which is the same, the full schema
      status,
    })
  );

  const { roles, isBaseOrSelfService, isBase } = useUserRoleHelper();

  const canCheckInBooking = userHasPermission({
    roles,
    entity: PermissionEntity.booking,
    action: PermissionAction.checkin,
  });
  const canCheckOutBooking = userHasPermission({
    roles,
    entity: PermissionEntity.booking,
    action: PermissionAction.checkout,
  });

  /** This is used when we have selfSErvice or Base as we are setting the default */
  const defaultTeamMember = teamMembers?.find(
    (m) => m.userId === custodianRef || m.id === custodianRef
  );

  const userCanSeeCustodian = userCanViewSpecificCustody({
    roles,
    custodianUserId: defaultTeamMember?.user?.id,
    organization: currentOrganization,
    currentUserId: userId,
  });

  useEffect(
    function updateEndDate() {
      if (incomingEndDate) {
        setEndDate(incomingEndDate);
      }
    },
    [incomingEndDate]
  );

  /**
   * Check whether the user can see actions
   * 1. Admin/Owner always can see all
   * 2. SELF_SERVICE can see actions if they are the custodian of the booking
   * 3. BASE can see actions if they are the custodian of the booking
   */

  const canSeeActions =
    !isBaseOrSelfService ||
    (isBaseOrSelfService &&
      (defaultTeamMember?.userId === userId ||
        defaultTeamMember?.id === userId));

  return (
    <div>
      <Form ref={zo.ref} method="post" action={action}>
        {/* Render the actions on top only when the form is in edit mode */}
        {!isNewBooking && canSeeActions ? (
          <AbsolutePositionedHeaderActions>
            <When truthy={isBase}>
              <BookingProcessSidebar />
            </When>

            {/* When the booking is Completed, there are no actions available for BASE role so we don't render it */}
            <ActionsDropdown />

            {/*  We show the button in all cases, unless the booking is in a final state */}
            {!(
              bookingStatus?.isCompleted ||
              bookingStatus?.isCancelled ||
              bookingStatus?.isArchived
            ) ? (
              <>
                <input
                  type="hidden"
                  name="nameChangeOnly"
                  value={bookingStatus?.isDraft ? "no" : "yes"}
                />
                <Button
                  type="submit"
                  disabled={disabled}
                  variant="secondary"
                  name="intent"
                  value="save"
                  className="grow"
                  size="sm"
                >
                  Save
                </Button>
              </>
            ) : null}

            {/* When booking is draft, we show the reserve button */}
            {bookingStatus?.isDraft ? (
              <Button
                disabled={
                  disabled ||
                  !bookingFlags?.hasAssets ||
                  bookingFlags?.hasAlreadyBookedAssets ||
                  bookingFlags?.hasUnavailableAssets
                    ? {
                        reason: bookingFlags?.hasUnavailableAssets
                          ? "You have some assets in your booking that are marked as unavailble. Either remove the assets from this booking or make them available again"
                          : bookingFlags?.hasAlreadyBookedAssets
                          ? "Your booking has assets that are already booked for the desired period. You need to resolve that before you can reserve"
                          : isProcessing
                          ? undefined
                          : "You need to add assets to your booking before you can reserve it",
                      }
                    : false
                }
                type="submit"
                name="intent"
                value="reserve"
                className="grow"
                size="sm"
              >
                {isBase ? "Request reservation" : "Reserve"}
              </Button>
            ) : null}

            {/* When booking is reserved, we show the check-out button */}
            <When truthy={bookingStatus?.isReserved && canCheckOutBooking}>
              <CheckoutDialog
                portalContainer={zo.form}
                booking={{ id, name: name!, from: startDate! }}
                disabled={
                  disabled ||
                  bookingFlags?.hasUnavailableAssets ||
                  bookingFlags?.hasCheckedOutAssets ||
                  bookingFlags?.hasAssetsInCustody
                    ? {
                        reason: bookingFlags?.hasAssetsInCustody
                          ? "Some assets in this booking are currently in custody. You need to resolve that before you can check-out"
                          : isProcessing
                          ? undefined
                          : "Some assets in this booking are not Available because they’re part of an Ongoing or Overdue booking",
                      }
                    : false
                }
              />
            </When>

            <When
              truthy={
                (bookingStatus?.isOngoing || bookingStatus?.isOverdue) &&
                canCheckInBooking
              }
            >
              <CheckinDialog
                portalContainer={zo.form}
                booking={{ id, name: name!, to: endDate! }}
                disabled={disabled}
              />
            </When>
          </AbsolutePositionedHeaderActions>
        ) : null}
        <div className="-mx-4 mb-4 md:mx-0">
          <div
            className={tw(
              "mb-8 w-full lg:mb-0 ",
              !isNewBooking ? "lg:w-[328px]" : ""
            )}
          >
            <div className="flex w-full flex-col gap-3">
              {id ? <input type="hidden" name="id" defaultValue={id} /> : null}
              <Card className="m-0">
                <FormRow
                  rowLabel={"Name"}
                  className="mobile-styling-only border-b-0 p-0"
                  required={true}
                >
                  <Input
                    label="Name"
                    hideLabel
                    name={zo.fields.name()}
                    disabled={
                      disabled ||
                      bookingStatus?.isCompleted ||
                      bookingStatus?.isCancelled ||
                      bookingStatus?.isArchived
                    }
                    error={zo.errors.name()?.message}
                    autoFocus
                    onChange={updateName}
                    className="mobile-styling-only w-full p-0"
                    defaultValue={name || undefined}
                    placeholder="Booking"
                    required
                  />
                </FormRow>
              </Card>
              <Card className="m-0">
                <FormRow
                  rowLabel="Start Date"
                  className="mobile-styling-only border-b-0 pb-[10px] pt-0"
                  required
                >
                  <Input
                    key={startDate}
                    label="Start Date"
                    type="datetime-local"
                    hideLabel
                    name={zo.fields.startDate()}
                    disabled={inputFieldIsDisabled}
                    error={zo.errors.startDate()?.message}
                    className="w-full"
                    defaultValue={startDate}
                    placeholder="Booking"
                    required
                    onChange={(event) => {
                      /**
                       * When user changes the startDate and the new startDate is greater than the endDate
                       * in that case, we have to update endDate to be the endDay date of startDate.
                       */
                      const newStartDate = new Date(event.target.value);
                      if (
                        isNewBooking &&
                        endDate &&
                        newStartDate > new Date(endDate)
                      ) {
                        const newEndDate = dateForDateTimeInputValue(
                          new Date(newStartDate.setHours(18, 0, 0))
                        );
                        setEndDate(
                          newEndDate.substring(0, newEndDate.length - 3)
                        );
                      }
                    }}
                  />
                </FormRow>
                <FormRow
                  rowLabel="End Date"
                  className="mobile-styling-only mb-2.5 border-b-0 p-0"
                  required
                >
                  <Input
                    key={"end-date-input"}
                    label="End Date"
                    type="datetime-local"
                    hideLabel
                    name={zo.fields.endDate()}
                    disabled={inputFieldIsDisabled}
                    error={zo.errors.endDate()?.message}
                    className="w-full"
                    placeholder="Booking"
                    required
                    value={endDate}
                    onChange={(event) => {
                      setEndDate(event.target.value);
                    }}
                  />
                </FormRow>
                <p className="text-[14px] text-gray-600">
                  Within this period the assets in this booking will be in
                  custody and unavailable for other bookings.
                </p>
              </Card>
              <Card className="m-0">
                <label className="mb-2.5 block font-medium text-gray-700">
                  <span className="required-input-label">Custodian</span>
                </label>
                <DynamicSelect
                  defaultValue={
                    defaultTeamMember
                      ? JSON.stringify({
                          id: defaultTeamMember?.id,
                          name: resolveTeamMemberName(defaultTeamMember),
                          userId: defaultTeamMember?.userId,
                        })
                      : undefined
                  }
                  disabled={
                    disabled || isBaseOrSelfService || inputFieldIsDisabled
                  }
                  model={{
                    name: "teamMember",
                    queryKey: "name",
                    deletedAt: null,
                  }}
                  fieldName="custodian"
                  contentLabel="Team members"
                  initialDataKey="teamMembers"
                  countKey="totalTeamMembers"
                  placeholder="Select a team member"
                  allowClear
                  closeOnSelect
                  transformItem={(
                    item: ModelFilterItem & { userId?: string }
                  ) => ({
                    ...item,
                    id: JSON.stringify({
                      id: item.id,
                      //If there is a user, we use its name, otherwise we use the name of the team member
                      name: resolveTeamMemberName(item),
                      userId: item?.userId,
                    }),
                  })}
                  renderItem={(item) =>
                    userCanSeeCustodian || isNewBooking
                      ? resolveTeamMemberName(item, true)
                      : "Private"
                  }
                />

                {zo.errors.custodian()?.message ? (
                  <div className="text-sm text-error-500">
                    {zo.errors.custodian()?.message}
                  </div>
                ) : null}
                <p className="mt-2 text-[14px] text-gray-600">
                  The person that will be in custody of or responsible for the
                  assets during the duration of the booking period.
                </p>
              </Card>
              <Card className="m-0">
                <FormRow
                  rowLabel="Description"
                  className="mobile-styling-only border-b-0 p-0"
                >
                  <Input
                    label="Description"
                    inputType="textarea"
                    hideLabel
                    name={zo.fields.description()}
                    disabled={
                      disabled ||
                      bookingStatus?.isCompleted ||
                      bookingStatus?.isCancelled ||
                      bookingStatus?.isArchived
                    }
                    error={zo.errors.description()?.message}
                    className="mobile-styling-only w-full p-0"
                    defaultValue={description || undefined}
                    placeholder="Add a description..."
                  />
                </FormRow>
              </Card>
              {!isNewBooking && (
                <AddToCalendar
                  disabled={
                    disabled ||
                    bookingStatus?.isDraft ||
                    bookingStatus?.isCancelled ||
                    false
                  }
                />
              )}
            </div>
          </div>
        </div>
        {isNewBooking ? (
          <Card className="sticky bottom-0 -mx-6 mb-0 rounded-none border-0 px-6 py-0 text-right">
            <div className="-mx-6 mb-3 border-t shadow" />
            {assetIds?.map((item, i) => (
              <input
                key={item}
                type="hidden"
                name={`assetIds[${i}]`}
                value={item}
              />
            ))}
            <div className="flex flex-col">
              {!assetIds ? (
                <Button
                  icon="scan"
                  className="mb-1"
                  type="submit"
                  disabled={disabled}
                  value="scan"
                  name="intent"
                >
                  Scan QR codes
                </Button>
              ) : null}
              <Button
                className="mb-3 whitespace-nowrap"
                icon={assetIds ? undefined : "rows"}
                value="create"
                name="intent"
                disabled={disabled}
              >
                {assetIds ? "Create Booking" : "View assets list"}
              </Button>
              <hr />
              <Button
                variant="secondary"
                to=".."
                width="full"
                disabled={disabled}
                className=" mt-3 whitespace-nowrap"
              >
                Cancel
              </Button>
            </div>
            <div className="h-3" />
          </Card>
        ) : null}
      </Form>
    </div>
  );
}

const AddToCalendar = ({ disabled }: { disabled: boolean }) => (
  <TooltipProvider delayDuration={100}>
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          to={`cal.ics`}
          download={true}
          reloadDocument={true}
          disabled={disabled}
          variant="secondary"
          icon="calendar"
        >
          Add to calendar
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p className="text-xs">
          {disabled
            ? "Not possible to add to calendar due to booking status"
            : "Download this booking as a calendar event"}
        </p>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
);
