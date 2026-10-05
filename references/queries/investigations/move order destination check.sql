SELECT
	mo.RaceID
	,mo.DestinationType
	,mo.DestinationID
	,mo.DestinationItemType
	,mo.DestinationItemID
	,mo.Description
	--,x.*
FROM
	FCT_MoveOrders as mo

--inner JOIN FCT_Wrecks as w on w.WreckID = mo.DestinationID and mo.DestinationType = 8
--left JOIN FCT_Population as p on p.PopulationID = mo.DestinationID and mo.DestinationType = 2
--inner JOIN FCT_SystemBody as x on x.SystemBodyID = mo.DestinationID and mo.DestinationType = 2
--inner JOIN FCT_JumpPoint as x on x.WarpPointID = mo.DestinationID and mo.DestinationType = 1
--inner JOIN FCT_Contacts as x on x.UniqueID = mo.DestinationID and mo.DestinationType = 6
inner JOIN FCT_Fleet as x on x.FleetID = mo.DestinationID and mo.DestinationType = 10

where mo.DestinationType = 10

order by mo.DestinationType